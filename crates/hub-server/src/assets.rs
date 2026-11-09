use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Instant};

#[derive(rust_embed::RustEmbed)]
#[folder = "../../frontend/dist/"]
struct Embedded;
const MAX_BUILD_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 256;
const PREVIOUS_BUILDS: usize = 2;

#[derive(Clone)]
struct Asset {
    data: Bytes,
    digest: String,
    generation: String,
}
impl Asset {
    fn new(data: Vec<u8>) -> Self {
        Self {
            digest: format!("{:x}", Sha256::digest(&data)),
            data: data.into(),
            generation: String::new(),
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    files: BTreeMap<String, String>,
}

// A running process serves one immutable snapshot, including HUB_ASSETS. Only
// original fingerprinted files can be recovered from previous snapshots.
pub struct Store {
    current: BTreeMap<String, Asset>,
    previous: BTreeMap<String, Asset>,
    pub generation: String,
    generations: Vec<String>,
    csp: String,
}
impl Store {
    pub fn load(home: &Path, external: Option<&Path>) -> anyhow::Result<Self> {
        let mut files = BTreeMap::new();
        if let Some(directory) = external {
            read_directory(directory, directory, &mut files)?;
        } else {
            for path in Embedded::iter() {
                let asset = Embedded::get(&path).expect("embedded asset");
                files.insert(path.into_owned(), Asset::new(asset.data.into_owned()));
            }
        }
        let mut store = Self::new(files)?;
        let directory = home.join("ui-assets");
        let history = read_small(&directory.join("history.json"), 4096)
            .and_then(|data| Ok(serde_json::from_slice::<Vec<String>>(&data)?))
            .unwrap_or_default();
        for generation in history {
            if store.generations.len() > PREVIOUS_BUILDS {
                break;
            }
            if !valid_digest(&generation) || store.generations.contains(&generation) {
                continue;
            }
            match read_archive(&directory, &generation) {
                Ok(files) => {
                    for (path, asset) in files {
                        store.previous.entry(path).or_insert(asset);
                    }
                    store.generations.push(generation);
                }
                Err(error) => {
                    tracing::warn!(%generation, %error, "Ignoring damaged UI resource archive")
                }
            }
        }
        // Cache failure must not prevent serving the embedded UI. An upgrade,
        // however, must checkpoint successfully before replacing the binary.
        if let Err(error) = store.checkpoint(home) {
            tracing::warn!(%error, "Unable to retain UI resources; embedded resources remain available");
        }
        Ok(store)
    }
    fn new(mut current: BTreeMap<String, Asset>) -> anyhow::Result<Self> {
        anyhow::ensure!(current.contains_key("index.html"), "UI index.html missing");
        anyhow::ensure!(current.len() <= MAX_FILES, "too many UI resources");
        anyhow::ensure!(
            current.values().map(|f| f.data.len()).sum::<usize>() <= MAX_BUILD_BYTES,
            "UI resources exceed 32 MiB"
        );
        let mut hash = Sha256::new();
        for (path, file) in &current {
            anyhow::ensure!(safe_path(path), "invalid UI resource path");
            hash.update(path.as_bytes());
            hash.update([0]);
            hash.update(file.digest.as_bytes());
        }
        let generation = format!("{:x}", hash.finalize());
        for file in current.values_mut() {
            file.generation.clone_from(&generation);
        }
        let html = std::str::from_utf8(&current["index.html"].data)?;
        // Hash the exact inline bootstrap in the built HTML, without granting
        // unsafe-inline script or eval permission.
        let bootstrap = html
            .split_once("<script id=\"hub-bootstrap\">")
            .and_then(|(_, rest)| rest.split_once("</script>"))
            .map(|(source, _)| format!(" 'sha256-{}'", STANDARD.encode(Sha256::digest(source))));
        let csp = format!("default-src 'self'; script-src 'self'{}; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", bootstrap.unwrap_or_default());
        Ok(Self {
            current,
            previous: BTreeMap::new(),
            generations: vec![generation.clone()],
            generation,
            csp,
        })
    }
    pub fn csp(&self) -> &str {
        &self.csp
    }
    #[cfg(test)]
    pub fn embedded_for_tests() -> Self {
        Self::new(
            Embedded::iter()
                .map(|path| {
                    let data = Embedded::get(&path).expect("embedded asset");
                    (path.into_owned(), Asset::new(data.data.into_owned()))
                })
                .collect(),
        )
        .expect("embedded UI resources")
    }
    pub fn checkpoint(&self, home: &Path) -> anyhow::Result<()> {
        let root = home.join("ui-assets");
        crate::config::private_dir(&root)?;
        let target = root.join(&self.generation);
        let complete = read_archive(&root, &self.generation).is_ok_and(|files| {
            let expected: BTreeMap<_, _> = self
                .current
                .iter()
                .filter(|(path, _)| fingerprinted(path))
                .map(|(path, asset)| (path, &asset.digest))
                .collect();
            let archived: BTreeMap<_, _> = files
                .iter()
                .map(|(path, asset)| (path, &asset.digest))
                .collect();
            expected == archived
        });
        if !complete {
            let staging = root.join(format!(".staging-{}", crate::security::token()));
            crate::config::private_dir(&staging)?;
            let result = (|| -> anyhow::Result<()> {
                let mut files = BTreeMap::new();
                for (path, asset) in &self.current {
                    if fingerprinted(path) {
                        crate::config::save(&staging.join(&asset.digest), &asset.data)?;
                        files.insert(path.clone(), asset.digest.clone());
                    }
                }
                crate::config::save(
                    &staging.join("manifest.json"),
                    &serde_json::to_vec(&Manifest { files })?,
                )?;
                if target.exists() {
                    std::fs::remove_dir_all(&target)?;
                }
                std::fs::rename(&staging, &target)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_dir_all(&staging);
            }
            result?;
        }
        crate::config::save(
            &root.join("history.json"),
            &serde_json::to_vec(&self.generations)?,
        )?;
        // Prune only our own generation directories, after publishing history.
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_digest(&name)
                && !self.generations.contains(&name)
                && entry.file_type()?.is_dir()
            {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }
    fn response(&self, uri: &Uri, method: &Method, headers: &HeaderMap) -> Response {
        if !matches!(*method, Method::GET | Method::HEAD) {
            return (
                StatusCode::METHOD_NOT_ALLOWED,
                [
                    (header::ALLOW, "GET, HEAD"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
            )
                .into_response();
        }
        let path = uri.path().trim_start_matches('/');
        let path = if path.is_empty() { "index.html" } else { path };
        let found = self.current.get_key_value(path).or_else(|| {
            if fingerprinted(path) {
                self.previous.get_key_value(path)
            } else if safe_path(path)
                && !path.contains('.')
                && !["assets", "api", "connector"]
                    .iter()
                    .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
            {
                self.current.get_key_value("index.html")
            } else {
                None
            }
        });
        let Some((path, asset)) = found else {
            return (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-store")]).into_response();
        };
        let etag = format!("\"{}\"", asset.digest);
        let unchanged = headers.get_all(header::IF_NONE_MATCH).iter().any(|value| {
            value.to_str().is_ok_and(|value| {
                value.split(',').any(|tag| {
                    let tag = tag.trim().strip_prefix("W/").unwrap_or(tag.trim());
                    tag == "*" || tag == etag
                })
            })
        });
        let mut response = Response::new(if unchanged || *method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(asset.data.clone())
        });
        *response.status_mut() = if unchanged {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        };
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .as_ref()
                .parse()
                .unwrap(),
        );
        headers.insert(header::ETAG, etag.parse().unwrap());
        headers.insert(
            header::CACHE_CONTROL,
            if fingerprinted(path) {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache, must-revalidate"
            }
            .parse()
            .unwrap(),
        );
        headers.insert("x-hub-asset-generation", asset.generation.parse().unwrap());
        if !unchanged {
            headers.insert(header::CONTENT_LENGTH, asset.data.len().into());
        }
        response
    }
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '%'])
        && path.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.chars().any(char::is_control)
        })
}
fn fingerprinted(path: &str) -> bool {
    safe_path(path)
        && path.starts_with("assets/")
        && path.rsplit_once('.').is_some_and(|(stem, _)| {
            stem.match_indices('-').any(|(index, _)| {
                let hash = &stem[index + 1..];
                (8..=64).contains(&hash.len())
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
        })
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn read_small(path: &Path, limit: usize) -> anyhow::Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= limit as u64,
        "invalid UI resource file"
    );
    use std::io::Read;
    let mut data = Vec::new();
    std::fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut data)?;
    anyhow::ensure!(data.len() <= limit, "UI resource too large");
    Ok(data)
}
fn read_directory(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Asset>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::fs::symlink_metadata(directory)?.is_dir(),
        "UI resource directory must not be a symlink"
    );
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = path
            .strip_prefix(root)?
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid UI resource name"))?
            .to_owned();
        if !safe_path(&name) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            read_directory(root, &path, files)?;
        } else {
            anyhow::ensure!(kind.is_file(), "UI resources must not contain symlinks");
            anyhow::ensure!(files.len() < MAX_FILES, "too many UI resources");
            let used = files.values().map(|f| f.data.len()).sum::<usize>();
            files.insert(name, Asset::new(read_small(&path, MAX_BUILD_BYTES - used)?));
        }
    }
    Ok(())
}
fn read_archive(root: &Path, generation: &str) -> anyhow::Result<BTreeMap<String, Asset>> {
    let directory = root.join(generation);
    anyhow::ensure!(
        std::fs::symlink_metadata(&directory)?.is_dir(),
        "invalid UI resource archive"
    );
    let manifest: Manifest =
        serde_json::from_slice(&read_small(&directory.join("manifest.json"), 64 * 1024)?)?;
    anyhow::ensure!(
        manifest.files.len() <= MAX_FILES,
        "too many archived UI resources"
    );
    let mut files = BTreeMap::new();
    let mut remaining = MAX_BUILD_BYTES;
    for (path, digest) in manifest.files {
        anyhow::ensure!(
            fingerprinted(&path) && valid_digest(&digest),
            "invalid archived resource path"
        );
        let mut asset = Asset::new(read_small(&directory.join(&digest), remaining)?);
        anyhow::ensure!(
            asset.digest == digest,
            "archived UI resource checksum mismatch"
        );
        remaining -= asset.data.len();
        asset.generation = generation.to_owned();
        files.insert(path, asset);
    }
    Ok(files)
}

pub async fn serve(
    State(app): State<crate::App>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    app.assets.response(&uri, &method, &headers)
}
// This records HTTP body consumption, not delivery by a TLS proxy to a browser.
struct Delivery {
    started: Instant,
    path: String,
    status: StatusCode,
    expected: Option<u64>,
    bytes: u64,
    failed: bool,
    generation: String,
}
impl Drop for Delivery {
    fn drop(&mut self) {
        let complete = !self.failed && self.expected == Some(self.bytes);
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        if complete && (self.status.is_success() || self.status == StatusCode::NOT_MODIFIED) {
            tracing::info!(path=%self.path, status=self.status.as_u16(), elapsed_ms, bytes=self.bytes, body_complete=complete, assets=%self.generation, revision=env!("HUB_REVISION"), "Static response");
        } else {
            tracing::warn!(path=%self.path, status=self.status.as_u16(), elapsed_ms, bytes=self.bytes, body_complete=complete, assets=%self.generation, revision=env!("HUB_REVISION"), "Static response");
        }
    }
}
pub async fn observe(State(app): State<crate::App>, request: Request, next: Next) -> Response {
    let started = Instant::now();
    let path = request.uri().path().to_owned();
    let head = request.method() == Method::HEAD;
    let static_request = !["/api/", "/connector/", "/healthz", "/readyz"]
        .iter()
        .any(|prefix| path.starts_with(prefix));
    let upgrade = path.starts_with("/api/v1/terminal-connections/") && path.ends_with("/ws");
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("x-hub-revision", env!("HUB_REVISION").parse().unwrap());
    response
        .headers_mut()
        .insert("x-hub-assets", app.assets.generation.parse().unwrap());
    if response.status().is_client_error() || response.status().is_server_error() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    if upgrade {
        tracing::info!(
            status = response.status().as_u16(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            revision = env!("HUB_REVISION"),
            "Terminal WebSocket handshake response"
        );
    }
    if !static_request {
        return response;
    }
    let expected = if head || response.status() == StatusCode::NOT_MODIFIED {
        Some(0)
    } else {
        response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok()?.parse().ok())
    };
    let delivery = Delivery {
        started,
        path,
        status: response.status(),
        expected,
        bytes: 0,
        failed: false,
        generation: app.assets.generation.clone(),
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), delivery),
        |(mut stream, mut delivery)| async move {
            match stream.next().await {
                Some(chunk) => {
                    match &chunk {
                        Ok(data) => delivery.bytes += data.len() as u64,
                        Err(_) => delivery.failed = true,
                    }
                    Some((chunk, (stream, delivery)))
                }
                None => {
                    if delivery.expected.is_none() {
                        delivery.expected = Some(delivery.bytes);
                    }
                    drop(delivery);
                    None
                }
            }
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> Store {
        Store::new(BTreeMap::from([
            (
                "index.html".into(),
                Asset::new(b"<html>hub</html>".to_vec()),
            ),
            (
                "assets/app-12345678.css".into(),
                Asset::new(b".app{display:flex}".to_vec()),
            ),
        ]))
        .unwrap()
    }
    fn request(store: &Store, path: &str, method: Method, etag: Option<&str>) -> Response {
        let mut headers = HeaderMap::new();
        if let Some(etag) = etag {
            headers.insert(header::IF_NONE_MATCH, etag.parse().unwrap());
        }
        store.response(&path.parse().unwrap(), &method, &headers)
    }
    #[tokio::test]
    async fn caching_conditionals_head_and_missing_resources() {
        let store = store();
        let html = request(&store, "/", Method::GET, None);
        assert_eq!(
            html.headers()[header::CACHE_CONTROL],
            "no-cache, must-revalidate"
        );
        let etag = html.headers()[header::ETAG].to_str().unwrap();
        let unchanged = request(
            &store,
            "/workspace",
            Method::GET,
            Some(&format!("\"other\", W/{etag}")),
        );
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            axum::body::to_bytes(unchanged.into_body(), 1024)
                .await
                .unwrap()
                .len(),
            0
        );
        let css = request(
            &store,
            "/assets/app-12345678.css?hub_retry=1",
            Method::HEAD,
            None,
        );
        assert_eq!(css.headers()[header::CONTENT_TYPE], "text/css");
        assert_eq!(css.headers()[header::CONTENT_LENGTH], "18");
        assert!(css.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable"));
        assert_eq!(
            axum::body::to_bytes(css.into_body(), 1024)
                .await
                .unwrap()
                .len(),
            0
        );
        for path in [
            "/assets/missing.css",
            "/assets/missing.js",
            "/assets/missing",
            "/api/missing",
            "/connector/missing",
            "/../config",
            "/%2e%2e/config",
        ] {
            let response = request(&store, path, Method::GET, None);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .len(),
                0
            );
        }
        assert_eq!(
            request(&store, "/", Method::POST, None).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
    #[test]
    fn retains_original_resources_bounds_history_and_rejects_corruption() {
        let home = std::env::temp_dir().join(crate::security::token());
        let external = home.join("external");
        crate::config::private_dir(&external.join("assets")).unwrap();
        std::fs::write(external.join("index.html"), "<html>old</html>").unwrap();
        let old_path = "assets/old-12345678.css";
        std::fs::write(external.join(old_path), "original css").unwrap();
        let old = Store::load(&home, Some(&external)).unwrap();
        let mut generations = vec![old.generation.clone()];
        for version in 1..=3 {
            std::fs::write(
                external.join("index.html"),
                format!("<html>{version}</html>"),
            )
            .unwrap();
            std::fs::remove_file(external.join(old_path)).ok();
            let store = Store::load(&home, Some(&external)).unwrap();
            let response = request(&store, &format!("/{old_path}"), Method::GET, None);
            if version <= PREVIOUS_BUILDS {
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers()["x-hub-asset-generation"], old.generation);
            } else {
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
            }
            generations.push(store.generation);
        }
        assert!(!home.join("ui-assets").join(&generations[0]).exists());
        let digest = &old.current[old_path].digest;
        let archive = home.join("ui-assets").join(&old.generation);
        crate::config::private_dir(&archive).unwrap();
        std::fs::write(
            archive.join("manifest.json"),
            serde_json::to_vec(&Manifest {
                files: BTreeMap::from([(old_path.into(), digest.clone())]),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(archive.join(digest), "damaged").unwrap();
        assert!(read_archive(&home.join("ui-assets"), &old.generation).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(home.join("ui-assets/history.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn checkpoint_repairs_a_valid_but_incomplete_manifest() {
        let home = std::env::temp_dir().join(crate::security::token());
        let store = store();
        store.checkpoint(&home).unwrap();
        let root = home.join("ui-assets");
        let manifest = root.join(&store.generation).join("manifest.json");
        std::fs::write(&manifest, br#"{"files":{}}"#).unwrap();
        assert!(read_archive(&root, &store.generation).unwrap().is_empty());
        store.checkpoint(&home).unwrap();
        let archived = read_archive(&root, &store.generation).unwrap();
        let path = "assets/app-12345678.css";
        assert_eq!(archived[path].data, store.current[path].data);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn embedded_and_external_resources_use_identical_snapshots() {
        let home = std::env::temp_dir().join(crate::security::token());
        let embedded = Store::load(&home, None).unwrap();
        let external = Store::load(
            &home,
            Some(Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../frontend/dist"
            ))),
        )
        .unwrap();
        assert_eq!(embedded.generation, external.generation);
        let html = std::str::from_utf8(&embedded.current["index.html"].data).unwrap();
        assert!(html.contains("<script id=\"hub-bootstrap\">"));
        assert!(embedded.csp.contains("'sha256-"));
        assert!(!embedded.csp.contains("script-src 'self' 'unsafe-inline'"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
