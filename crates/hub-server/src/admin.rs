use crate::{security::*, App};
use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{Mutex, Notify};
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Update {
    pub active: bool,
    pub stage: String,
    pub target: String,
    #[serde(default)]
    pub target_revision: String,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}
pub struct Admin {
    pub runtime: crate::config::Runtime,
    pub executable: std::path::PathBuf,
    pub started: std::time::Instant,
    pub operation: AtomicBool,
    pub restart: Notify,
    pub update: Mutex<Update>,
    pub credentials: Mutex<()>,
}
impl Admin {
    pub fn new(runtime: crate::config::Runtime) -> Self {
        let mut previous = std::fs::read(runtime.home.join("upgrade.json"))
            .ok()
            .and_then(|v| serde_json::from_slice::<Update>(&v).ok())
            .unwrap_or_default();
        if previous.active {
            previous.active = false;
            previous.stage = if previous.stage == "restarting"
                && previous.target_revision == env!("HUB_REVISION")
            {
                "complete".into()
            } else {
                "interrupted".into()
            };
        }
        Self {
            executable: std::env::current_exe().expect("current executable path"),
            runtime,
            started: std::time::Instant::now(),
            operation: AtomicBool::new(false),
            restart: Notify::new(),
            update: Mutex::new(previous),
            credentials: Mutex::new(()),
        }
    }
}
async fn require(app: &App, h: &HeaderMap) -> Result<Session> {
    let s = session(app, h).await?;
    if !s.is_admin {
        return Err(denied());
    }
    Ok(s)
}
pub async fn dashboard(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    let instances: i64 = sqlx::query_scalar("SELECT count(*) FROM instances")
        .fetch_one(&app.db)
        .await?;
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE expires>?")
        .bind(now())
        .fetch_one(&app.db)
        .await?;
    let devices = app.devices.lock().await;
    Ok(Json(
        json!({"users":users,"instances":instances,"online":devices.len(),"sessions":sessions,"offline":instances.saturating_sub(devices.len() as i64).max(0),"uptime_seconds":app.admin.started.elapsed().as_secs(),"version":env!("CARGO_PKG_VERSION"),"revision":env!("HUB_REVISION")}),
    ))
}
pub async fn logs(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    require(&app, &h).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut entries = tokio::fs::read_dir(app.admin.runtime.home.join("logs"))
        .await
        .map_err(|_| bad())?;
    let mut files = Vec::new();
    while let Some(e) = entries.next_entry().await.map_err(|_| bad())? {
        if e.file_name().to_string_lossy().starts_with("hub.log")
            && e.file_type().await.map_err(|_| bad())?.is_file()
        {
            files.push(e.path())
        }
    }
    files.sort();
    let mut text = String::new();
    if let Some(path) = files.last() {
        let mut file = tokio::fs::File::open(path).await.map_err(|_| bad())?;
        let size = file.metadata().await.map_err(|_| bad())?.len();
        file.seek(std::io::SeekFrom::Start(size.saturating_sub(128 * 1024)))
            .await
            .map_err(|_| bad())?;
        let mut bytes = Vec::new();
        file.take(128 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| bad())?;
        text = String::from_utf8_lossy(&bytes).into_owned();
    }
    Ok(Json(json!({"text":text,"limit_bytes":131072})))
}
pub async fn restart(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = require(&app, &h).await?;
    if app.admin.operation.swap(true, Ordering::SeqCst) {
        return Err(Error(axum::http::StatusCode::CONFLICT, "operation_active"));
    }
    crate::api::audit(&app, &s.username, "system_restart", "").await;
    schedule_restart(app.admin.clone());
    Ok(Json(json!({"ok":true})))
}
fn schedule_restart(admin: Arc<Admin>) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        admin.restart.notify_one();
    });
}
const REPO: &str = "Xiechengqi/gotty-hub";
fn asset_name() -> anyhow::Result<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => anyhow::bail!("unsupported architecture"),
    };
    anyhow::ensure!(
        std::env::consts::OS == "linux",
        "automatic upgrades require Linux"
    );
    Ok(format!("gotty-hub-linux-{arch}"))
}
async fn release(app: &App) -> anyhow::Result<Value> {
    let response = app
        .http
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("User-Agent", "gotty-hub")
        .send()
        .await;
    if let Ok(response) = response {
        if response.status().is_success() {
            anyhow::ensure!(
                response.content_length().unwrap_or(0) < 2 * 1024 * 1024,
                "release metadata too large"
            );
            return Ok(response.json().await?);
        }
    }
    // Public release redirects work even when an unauthenticated shared IP exhausts API quota.
    let response = app
        .http
        .get(format!("https://github.com/{REPO}/releases/latest"))
        .header("User-Agent", "gotty-hub")
        .send()
        .await?
        .error_for_status()?;
    let prefix = format!("/{REPO}/releases/tag/");
    anyhow::ensure!(
        response.url().scheme() == "https" && response.url().host_str() == Some("github.com"),
        "invalid release redirect"
    );
    let tag = response
        .url()
        .path()
        .strip_prefix(&prefix)
        .filter(|v| !v.is_empty() && !v.contains('/'))
        .ok_or_else(|| anyhow::anyhow!("missing latest release"))?;
    let name = asset_name()?;
    Ok(
        json!({"tag_name":tag,"html_url":response.url().as_str(),"assets":[{"name":name,"browser_download_url":format!("https://github.com/{REPO}/releases/download/{tag}/{name}")},{"name":format!("{name}.sha256"),"browser_download_url":format!("https://github.com/{REPO}/releases/download/{tag}/{name}.sha256")}]}),
    )
}
pub async fn version(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let release = release(&app)
        .await
        .map_err(|_| Error(axum::http::StatusCode::BAD_GATEWAY, "release_unavailable"))?;
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"revision":env!("HUB_REVISION"),"latest":release["tag_name"],"url":release["html_url"],"asset":asset_name().ok()}),
    ))
}
pub async fn status(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    require(&app, &h).await?;
    Ok(Json(json!(*app.admin.update.lock().await)))
}
async fn set_update(app: &App, change: impl FnOnce(&mut Update)) {
    let mut state = app.admin.update.lock().await;
    change(&mut state);
    if let Ok(data) = serde_json::to_vec(&*state) {
        let _ = crate::config::save(&app.admin.runtime.home.join("upgrade.json"), &data);
    }
}
pub async fn upgrade(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = require(&app, &h).await?;
    if app.admin.operation.swap(true, Ordering::SeqCst) {
        return Err(Error(axum::http::StatusCode::CONFLICT, "operation_active"));
    }
    set_update(&app, |s| {
        *s = Update {
            active: true,
            stage: "checking".into(),
            ..Default::default()
        }
    })
    .await;
    crate::api::audit(&app, &s.username, "system_upgrade", "").await;
    tokio::spawn(async move {
        match install(&app).await {
            Ok(()) => {
                set_update(&app, |s| s.stage = "restarting".into()).await;
                schedule_restart(app.admin.clone())
            }
            Err(e) => {
                tracing::warn!("Upgrade failed: {e}");
                set_update(&app, |s| {
                    s.active = false;
                    s.stage = "failed".into();
                    s.error = Some("Upgrade failed; inspect system logs".into())
                })
                .await;
                app.admin.operation.store(false, Ordering::SeqCst);
            }
        }
    });
    Ok(Json(json!({"ok":true})))
}
fn download_url(value: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url
                .path()
                .starts_with(&format!("/{REPO}/releases/download/"))
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid release asset URL"
    );
    Ok(url)
}
fn checksum(text: &str, name: &str) -> anyhow::Result<String> {
    let fields: Vec<_> = text.split_whitespace().collect();
    anyhow::ensure!(
        fields.len() == 2
            && fields[0].len() == 64
            && fields[0].bytes().all(|v| v.is_ascii_hexdigit())
            && fields[1].trim_start_matches('*') == name,
        "invalid asset checksum"
    );
    Ok(fields[0].to_lowercase())
}
async fn install(app: &App) -> anyhow::Result<()> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let name = asset_name()?;
    let release = release(app).await?;
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing release assets"))?;
    let find = |name: &str| -> anyhow::Result<reqwest::Url> {
        download_url(
            assets
                .iter()
                .find(|a| a["name"] == name)
                .and_then(|a| a["browser_download_url"].as_str())
                .ok_or_else(|| anyhow::anyhow!("release asset missing"))?,
        )
    };
    let hash_url = find(&format!("{name}.sha256"))?;
    let binary_url = find(&name)?;
    let expected = app.http.get(hash_url).send().await?.error_for_status()?;
    anyhow::ensure!(
        expected.content_length().unwrap_or(0) < 4096,
        "checksum too large"
    );
    let expected = checksum(&expected.text().await?, &name)?;
    let directory = app.admin.runtime.home.join("updates");
    crate::config::private_dir(&directory)?;
    let current = app.admin.executable.clone();
    let staging = current.with_file_name(format!(".gotty-hub-{}", token()));
    let result = async {
        let response = app
            .http
            .get(binary_url)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await?
            .error_for_status()?;
        let total = response.content_length().unwrap_or(0);
        anyhow::ensure!(total <= 256 * 1024 * 1024, "release binary too large");
        set_update(app, |s| {
            s.stage = "downloading".into();
            s.target = release["tag_name"].as_str().unwrap_or("").into();
            s.target_revision = release["target_commitish"].as_str().unwrap_or("").into();
            s.total = total
        })
        .await;
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o700);
        let mut file = options.open(&staging).await?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut count = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            count += chunk.len() as u64;
            anyhow::ensure!(count <= 256 * 1024 * 1024, "release binary too large");
            digest.update(&chunk);
            file.write_all(&chunk).await?;
            let mut state = app.admin.update.lock().await;
            state.downloaded = count;
        }
        file.sync_all().await?;
        drop(file);
        anyhow::ensure!(
            format!("{:x}", digest.finalize()) == expected,
            "SHA256 verification failed"
        );
        let probe = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::process::Command::new(&staging)
                .arg("--version")
                .output(),
        )
        .await??;
        anyhow::ensure!(
            probe.status.success()
                && String::from_utf8_lossy(&probe.stdout).starts_with("gotty-hub "),
            "release binary verification failed"
        );
        let probe_text = String::from_utf8_lossy(&probe.stdout);
        supported_release(&probe_text)?;
        if let Some(revision) = probe_text
            .split('(')
            .nth(1)
            .and_then(|v| v.split(')').next())
        {
            set_update(app, |s| s.target_revision = revision.into()).await;
        }
        set_update(app, |s| s.stage = "backing_up".into()).await;
        let backup = directory.join(format!("hub-{}.db", now()));
        sqlx::query("VACUUM INTO ?")
            .bind(backup.to_string_lossy().as_ref())
            .execute(&app.db)
            .await?;
        tokio::fs::copy(&current, directory.join("previous.bin")).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)).await?;
            tokio::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600)).await?;
        }
        tokio::fs::rename(&staging, &current).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&staging).await;
    }
    result
}
fn supported_release(output: &str) -> anyhow::Result<()> {
    fn version(value: &str) -> Option<(u64, u64, u64)> {
        let parts: Vec<_> = value.split('.').map(str::parse::<u64>).collect();
        if parts.len() != 3 {
            return None;
        }
        Some((
            *parts[0].as_ref().ok()?,
            *parts[1].as_ref().ok()?,
            *parts[2].as_ref().ok()?,
        ))
    }
    let candidate = output
        .split_whitespace()
        .nth(1)
        .and_then(version)
        .ok_or_else(|| anyhow::anyhow!("invalid release version"))?;
    let current = version(env!("CARGO_PKG_VERSION")).expect("package version");
    anyhow::ensure!(
        candidate >= current,
        "release is older than this installation; refusing incompatible downgrade"
    );
    Ok(())
}
pub fn exec_restart(path: &std::path::Path, password: &str) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let stdin_password = args.iter().any(|arg| arg == "--password-stdin");
        let mut command = std::process::Command::new(path);
        command.args(
            args.iter()
                .filter(|arg| arg.as_os_str() != "--password-stdin"),
        );
        // A pipe cannot be consumed again after exec. Keep its startup override in the environment.
        if stdin_password {
            command.env("HUB_PASSWORD", password);
        }
        let error = command.exec();
        Err(error.into())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, password);
        anyhow::bail!("restart requires Unix")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_must_not_downgrade_username_schema() {
        assert!(supported_release("gotty-hub 0.1.0 (legacy)").is_err());
        assert!(supported_release(concat!(
            "gotty-hub ",
            env!("CARGO_PKG_VERSION"),
            " (current)"
        ))
        .is_ok());
        assert!(supported_release("gotty-hub invalid").is_err());
    }
    #[test]
    fn trusted_urls_and_checksums() {
        assert!(download_url(
            "https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64"
        )
        .is_ok());
        assert!(download_url("https://evil.test/file").is_err());
        assert!(download_url("https://github.com/other/repo/releases/download/v1/file").is_err());
        assert!(checksum(&format!("{}  app", "a".repeat(64)), "app").is_ok());
        assert!(checksum(&format!("{}  wrong", "a".repeat(64)), "app").is_err());
    }
}
