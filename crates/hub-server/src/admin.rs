use crate::{security::*, App};
use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Update {
    pub active: bool,
    pub stage: String,
    pub target: String,
    #[serde(default)]
    pub target_revision: String,
    pub downloaded: u64,
    pub total: u64,
    #[serde(default)]
    pub source: String,
    pub error: Option<String>,
}
pub struct Admin {
    pub runtime: crate::config::Runtime,
    pub executable: std::path::PathBuf,
    pub started: std::time::Instant,
    pub operation: AtomicBool,
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
    if app.shutdown.is_stopping() {
        return Err(Error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "server_shutting_down",
        ));
    }
    if app.admin.operation.swap(true, Ordering::SeqCst) {
        return Err(Error(axum::http::StatusCode::CONFLICT, "operation_active"));
    }
    crate::api::audit(&app, &s.username, "system_restart", "").await;
    schedule_restart(&app);
    Ok(Json(json!({"ok":true})))
}
fn schedule_restart(app: &App) {
    let shutdown = app.shutdown.clone();
    app.shutdown.tasks().spawn(async move {
        if shutdown
            .until_stopped(tokio::time::sleep(std::time::Duration::from_millis(700)))
            .await
            .is_some()
        {
            shutdown.restart();
        }
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
    let api = format!("https://api.github.com/repos/{REPO}/releases/latest");
    // API JSON first, then the public redirect, each through the mirror chain.
    let mut last = None;
    for candidate in candidates(&api) {
        match get(app, &candidate, PROBE).await {
            Ok(response)
                if response.status().is_success()
                    && response.content_length().unwrap_or(0) < 2 * 1024 * 1024 =>
            {
                // A mirror can return 200 with a non-JSON error page; keep trying.
                match response.json().await {
                    Ok(value) => return Ok(value),
                    Err(error) => last = Some(error.into()),
                }
            }
            Ok(response) => last = Some(anyhow::anyhow!("HTTP {}", response.status())),
            Err(error) => last = Some(error),
        }
    }
    // Public release redirects work even when an unauthenticated shared IP exhausts API quota.
    let latest = format!("https://github.com/{REPO}/releases/latest");
    for candidate in candidates(&latest) {
        let response = match get(app, &candidate, PROBE).await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last = Some(anyhow::anyhow!("HTTP {}", response.status()));
                continue;
            }
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        let final_url = response.url().clone();
        // Mirrors may keep the proxied URL in the path or redirect to github.com.
        if let Some(tag) = release_tag(final_url.path()) {
            let name = asset_name()?;
            return Ok(
                json!({"tag_name":tag,"html_url":final_url.as_str(),"assets":[{"name":name,"browser_download_url":format!("https://github.com/{REPO}/releases/download/{tag}/{name}")},{"name":format!("{name}.sha256"),"browser_download_url":format!("https://github.com/{REPO}/releases/download/{tag}/{name}.sha256")}]}),
            );
        }
        last = Some(anyhow::anyhow!("missing release tag"));
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("release metadata unavailable")))
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
    if app.shutdown.is_stopping() {
        return Err(Error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "server_shutting_down",
        ));
    }
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
    app.shutdown.tasks().spawn({
        let app = app.clone();
        async move {
            match app.shutdown.until_stopped(install(&app)).await {
                Some(Ok(())) => {
                    set_update(&app, |s| s.stage = "restarting".into()).await;
                    schedule_restart(&app)
                }
                None => {
                    set_update(&app, |s| {
                        s.active = false;
                        s.stage = "interrupted".into();
                    })
                    .await;
                    app.admin.operation.store(false, Ordering::SeqCst);
                }
                Some(Err(e)) => {
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
        }
    });
    Ok(Json(json!({"ok":true})))
}
// GitHub mirrors tried in order when the direct connection fails. Each is an
// HTTPS URL prefix; the sha256 check still pins content to the release hash.
const PROXIES: [&str; 2] = ["https://sina.dev/", "https://httptunnel.top/gh/"];
// The shared client caps every request at 15s, which a release download outgrows,
// so upgrade fetches use their own client and name the budget per request.
const PROBE: std::time::Duration = std::time::Duration::from_secs(8);
const DOWNLOAD: std::time::Duration = std::time::Duration::from_secs(300);
fn mirrored(url: &str, proxy: &str) -> String {
    format!("{proxy}{url}")
}
fn candidates(url: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(url.to_string()).chain(PROXIES.iter().map(|proxy| mirrored(url, proxy)))
}
fn source_label(url: &str) -> String {
    if url.starts_with("https://github.com/") || url.starts_with("https://api.github.com/") {
        return "github".into();
    }
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "mirror".into())
}
fn release_tag(path: &str) -> Option<&str> {
    let prefix = format!("/{REPO}/releases/tag/");
    path.rsplit("/releases/tag/")
        .next()
        .filter(|tag| !tag.is_empty() && !tag.contains('/'))
        .or_else(|| path.strip_prefix(&prefix))
        .filter(|tag| !tag.is_empty() && !tag.contains('/'))
}
// Asset URLs must be the canonical GitHub path, either directly or behind one
// of the two mirrors. Mirrors prepend their own prefix and keep the rest.
fn download_url(value: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    anyhow::ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "invalid release asset URL"
    );
    let host = url.host_str().unwrap_or("");
    let canonical = format!("/{REPO}/releases/download/");
    let path = match host {
        "github.com" => url.path(),
        "sina.dev" => url
            .path()
            .strip_prefix("/https://github.com")
            .ok_or_else(|| anyhow::anyhow!("invalid release asset URL"))?,
        "httptunnel.top" => url
            .path()
            .strip_prefix("/gh/https://github.com")
            .ok_or_else(|| anyhow::anyhow!("invalid release asset URL"))?,
        _ => anyhow::bail!("invalid release asset URL"),
    };
    anyhow::ensure!(path.starts_with(&canonical), "invalid release asset URL");
    Ok(url)
}
fn fetch_client(total: std::time::Duration) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(PROBE)
        .timeout(total)
        .build()?)
}
fn allowed_fetch(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    // Compare the raw path: Url::path() decodes %2F into '/', which would let a
    // mirror prefix smuggle a different host past the check below.
    let raw = url.path();
    let (host, path) = if url.host_str() == Some("sina.dev") {
        ("", raw.strip_prefix('/').unwrap_or(""))
    } else if url.host_str() == Some("httptunnel.top") {
        ("", raw.strip_prefix("/gh/").unwrap_or(""))
    } else {
        (url.host_str().unwrap_or(""), raw)
    };
    if host.is_empty() {
        // A mirror only ever fronts one of the two GitHub hosts, verbatim.
        return path.starts_with("https://") && allowed_fetch(path);
    }
    match host {
        "api.github.com" => path == format!("/repos/{REPO}/releases/latest"),
        "github.com" => path.starts_with(&format!("/{REPO}/releases/")),
        _ => false,
    }
}
async fn get(
    app: &App,
    url: &str,
    total: std::time::Duration,
) -> anyhow::Result<reqwest::Response> {
    if app.shutdown.is_stopping() {
        anyhow::bail!("upgrade interrupted by shutdown");
    }
    anyhow::ensure!(allowed_fetch(url), "invalid release asset URL");
    Ok(fetch_client(total)?
        .get(url)
        .header("User-Agent", "gotty-hub")
        .send()
        .await?)
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
// Small text fetch (checksums) with the three-level fallback: direct, then
// each mirror. A bad body is that source's failure, not the end of the upgrade.
async fn get_text(app: &App, url: &str, limit: u64) -> anyhow::Result<String> {
    let mut last = None;
    for candidate in candidates(url) {
        let response = match get(app, &candidate, PROBE).await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last = Some(anyhow::anyhow!("HTTP {}", response.status()));
                continue;
            }
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        if response.content_length().unwrap_or(0) > limit {
            last = Some(anyhow::anyhow!("response too large"));
            continue;
        }
        let body = match response.bytes().await {
            Ok(body) if body.len() as u64 <= limit => body,
            Ok(_) => {
                last = Some(anyhow::anyhow!("response too large"));
                continue;
            }
            Err(error) => {
                last = Some(error.into());
                continue;
            }
        };
        match String::from_utf8(body.to_vec()) {
            Ok(text) => return Ok(text.trim().to_string()),
            Err(error) => last = Some(error.into()),
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("unreachable")))
}
// Stream a release asset to `staging`, verifying size and sha256 as it goes.
// Tries direct first, then each mirror; the last error wins.
async fn get_binary(
    app: &App,
    url: &str,
    staging: &std::path::Path,
    expected: &str,
) -> anyhow::Result<u64> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let mut last = None;
    for candidate in candidates(url) {
        let response = match get(app, &candidate, DOWNLOAD).await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last = Some(anyhow::anyhow!("HTTP {}", response.status()));
                continue;
            }
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        let total = response.content_length().unwrap_or(0);
        if total > 256 * 1024 * 1024 {
            last = Some(anyhow::anyhow!("release binary too large"));
            continue;
        }
        let source = source_label(&candidate);
        set_update(app, |s| {
            s.stage = "downloading".into();
            s.source = source;
            s.total = total;
            s.downloaded = 0;
        })
        .await;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o700);
        }
        let mut file = match options.open(staging) {
            Ok(file) => tokio::fs::File::from_std(file),
            Err(error) => {
                last = Some(error.into());
                continue;
            }
        };
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut count = 0u64;
        let result: anyhow::Result<()> = async {
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
            Ok(())
        }
        .await;
        drop(file);
        match result {
            Ok(()) if count > 0 && format!("{:x}", digest.finalize()) == expected => {
                return Ok(total);
            }
            Ok(()) if count == 0 => last = Some(anyhow::anyhow!("empty response")),
            Ok(()) => last = Some(anyhow::anyhow!("SHA256 verification failed")),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("unreachable")))
}
async fn install(app: &App) -> anyhow::Result<()> {
    let name = asset_name()?;
    let release = release(app).await?;
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing release assets"))?;
    let find = |name: &str| -> anyhow::Result<String> {
        let raw = assets
            .iter()
            .find(|a| a["name"] == name)
            .and_then(|a| a["browser_download_url"].as_str())
            .ok_or_else(|| anyhow::anyhow!("release asset missing"))?;
        // Validate the direct URL now; mirrors are derived later.
        download_url(raw)?;
        Ok(raw.to_string())
    };
    let hash_url = find(&format!("{name}.sha256"))?;
    let binary_url = find(&name)?;
    // Try direct, then each mirror; an 8s probe bounds the direct attempt.
    let expected = get_text(app, hash_url.as_str(), 4096).await?;
    let expected = checksum(&expected, &name)?;
    let directory = app.admin.runtime.home.join("updates");
    crate::config::private_dir(&directory)?;
    let current = app.admin.executable.clone();
    let staging = current.with_file_name(format!(".gotty-hub-{}", token()));
    async {
        set_update(app, |s| {
            s.stage = "downloading".into();
            s.target = release["tag_name"].as_str().unwrap_or("").into();
            s.target_revision = release["target_commitish"].as_str().unwrap_or("").into();
        })
        .await;
        let _staging_guard = StagingFile(staging.clone());
        let total = get_binary(app, binary_url.as_str(), &staging, &expected).await?;
        set_update(app, |s| s.total = total).await;
        let probe = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::process::Command::new(&staging)
                .arg("--version")
                .kill_on_drop(true)
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
        anyhow::ensure!(
            !app.shutdown.is_stopping(),
            "upgrade interrupted by shutdown"
        );
        // Retain original hashed resources before replacing the executable.
        app.assets.checkpoint(&app.admin.runtime.home)?;
        anyhow::ensure!(
            !app.shutdown.is_stopping(),
            "upgrade interrupted by shutdown"
        );
        // No await between the final cancellation check and atomic replacement.
        std::fs::rename(&staging, &current)?;
        Ok::<_, anyhow::Error>(())
    }
    .await
}
struct StagingFile(std::path::PathBuf);
impl Drop for StagingFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
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
        // Mirrors are allowed only as prefixes over the canonical GitHub asset path.
        assert!(download_url(
            "https://sina.dev/https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64"
        )
        .is_ok());
        assert!(download_url(
            "https://httptunnel.top/gh/https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64"
        )
        .is_ok());
        assert!(download_url("https://sina.dev/https://evil.test/file").is_err());
        assert!(download_url(
            "https://attacker.test/gh/https://github.com/Xiechengqi/gotty-hub/releases/download/v1/f"
        )
        .is_err());
        // A mirror must front GitHub itself, not an arbitrary host that happens
        // to mention the repository path.
        assert!(download_url(
            "https://sina.dev/https://evil.test/Xiechengqi/gotty-hub/releases/download/v1/f"
        )
        .is_err());
        assert!(download_url("https://sina.dev/https://github.com.evil.test/file").is_err());
        assert_eq!(
            release_tag("/Xiechengqi/gotty-hub/releases/tag/v1.2.3"),
            Some("v1.2.3")
        );
        assert_eq!(
            release_tag("/gh/https://github.com/Xiechengqi/gotty-hub/releases/tag/v1.2.3"),
            Some("v1.2.3")
        );
        // The fallback parse still rejects a tag that carries its own path.
        assert_eq!(
            release_tag("/Xiechengqi/gotty-hub/releases/tag/v1/extra"),
            None
        );
        assert_eq!(release_tag("/Xiechengqi/gotty-hub/releases/latest"), None);
        let api = "https://api.github.com/repos/Xiechengqi/gotty-hub/releases/latest";
        assert!(allowed_fetch(api));
        assert!(allowed_fetch(&mirrored(api, PROXIES[0])));
        assert!(allowed_fetch(&mirrored(api, PROXIES[1])));
        assert!(!allowed_fetch(
            "https://api.github.com/repos/Xiechengqi/gotty-hub/contents/main"
        ));
        assert!(!allowed_fetch("https://sina.dev/https://evil.test/file"));
        // Percent-encoded slashes must not turn the mirror prefix into another host.
        assert!(!allowed_fetch(
            "https://sina.dev/https:%2F%2Fevil.test/Xiechengqi/gotty-hub/releases/latest"
        ));
        assert!(!allowed_fetch(
            "https://httptunnel.top/gh/https:%2F%2Fevil.test/Xiechengqi/gotty-hub/releases/latest"
        ));
        assert!(checksum(&format!("{}  app", "a".repeat(64)), "app").is_ok());
        assert!(checksum(&format!("{}  wrong", "a".repeat(64)), "app").is_err());
        // Fallback order: direct, then the two mirrors in order.
        let direct =
            "https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64";
        let order: Vec<_> = std::iter::once(direct.to_string())
            .chain(PROXIES.iter().map(|p| mirrored(direct, p)))
            .collect();
        assert_eq!(order[0], direct);
        assert_eq!(
            order[1],
            "https://sina.dev/https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64"
        );
        assert_eq!(
            order[2],
            "https://httptunnel.top/gh/https://github.com/Xiechengqi/gotty-hub/releases/download/v1/gotty-hub-linux-amd64"
        );
        assert_eq!(source_label(&order[0]), "github");
        assert_eq!(source_label(&order[1]), "sina.dev");
        assert_eq!(source_label(&order[2]), "httptunnel.top");
    }
}
