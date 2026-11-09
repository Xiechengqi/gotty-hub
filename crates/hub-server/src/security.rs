use crate::App;
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error(pub StatusCode, pub &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error=%e,"database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "database_error")
    }
}
pub fn bad() -> Error {
    Error(StatusCode::BAD_REQUEST, "invalid_request")
}
pub fn denied() -> Error {
    Error(StatusCode::FORBIDDEN, "forbidden")
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
pub fn token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn email(s: &str) -> Result<String> {
    let s = s.trim().to_lowercase();
    if s.len() > 254
        || s.contains(['\r', '\n', ' '])
        || s.split('@').count() != 2
        || !s.split('@').nth(1).unwrap_or("").contains('.')
        || s.starts_with('@')
    {
        return Err(bad());
    }
    Ok(s)
}
pub async fn limit(app: &App, key: String, max: u32) -> Result<()> {
    let mut rates = app.rates.lock().await;
    let t = now() as u64;
    if rates.len() > 10000 {
        rates.retain(|_, v| t.saturating_sub(v.0) < 300);
        if rates.len() > 10000 {
            return Err(Error(StatusCode::TOO_MANY_REQUESTS, "rate_limit"));
        }
    }
    let e = rates.entry(key).or_insert((t, 0));
    if t.saturating_sub(e.0) >= 300 {
        *e = (t, 0)
    };
    e.1 += 1;
    if e.1 > max {
        return Err(Error(StatusCode::TOO_MANY_REQUESTS, "rate_limit"));
    }
    Ok(())
}
#[derive(Clone)]
pub struct Session {
    pub key: String,
    pub email: String,
    pub csrf: String,
}
pub async fn session(app: &App, headers: &HeaderMap) -> Result<Session> {
    let cookie = headers
        .get("cookie")
        .and_then(|x| x.to_str().ok())
        .unwrap_or("");
    let value = cookie
        .split(';')
        .find_map(|c| c.trim().strip_prefix("hub_session="))
        .ok_or(Error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    let key = hash(value);
    let row = sqlx::query("SELECT email,csrf FROM sessions WHERE token=? AND expires>?")
        .bind(&key)
        .bind(now())
        .fetch_optional(&app.db)
        .await?
        .ok_or(Error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    Ok(Session {
        key,
        email: row.get("email"),
        csrf: row.get("csrf"),
    })
}
pub async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path();
    if path.starts_with("/api/v1/auth/") || path.starts_with("/api/v1/enrollments") {
        let ip = request
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|v| v.0.ip().to_string())
            .unwrap_or_else(|| "local".into());
        if let Err(e) = limit(&app, format!("public:{ip}"), 100).await {
            return e.into_response();
        }
    }
    if let Some(origin) = request.headers().get("origin") {
        if origin.to_str().ok() != Some(app.origin.as_str()) {
            return denied().into_response();
        }
    }
    if method != axum::http::Method::GET && method != axum::http::Method::HEAD {
        if request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.starts_with("application/json"))
            != Some(true)
        {
            return bad().into_response();
        }
        if !path.starts_with("/api/v1/enrollments")
            && !path.starts_with("/api/v1/auth/otp/")
            && !path.ends_with("/password/login")
            && !path.ends_with("/password/reset")
            && !path.ends_with("/password/verify-reset")
        {
            match session(&app, request.headers()).await {
                Ok(s) => {
                    if request
                        .headers()
                        .get("x-csrf-token")
                        .and_then(|x| x.to_str().ok())
                        != Some(s.csrf.as_str())
                    {
                        return denied().into_response();
                    }
                }
                Err(e) => return e.into_response(),
            }
        }
    }
    let mut response = next.run(request).await;
    let h = response.headers_mut();
    h.insert("cache-control", "no-store".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}
pub async fn login(app: &App, mail: &str) -> Result<(HeaderMap, Json<Value>)> {
    login_checked(app, mail, None).await
}
pub async fn login_checked(
    app: &App,
    mail: &str,
    expected_password: Option<&str>,
) -> Result<(HeaderMap, Json<Value>)> {
    sqlx::query("INSERT OR IGNORE INTO users(email) VALUES(?)")
        .bind(mail)
        .execute(&app.db)
        .await?;
    crate::api::audit(app, mail, "login", "").await;
    let raw = token();
    let csrf = token();
    let inserted = sqlx::query("INSERT INTO sessions SELECT ?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM users WHERE email=? AND password=?)")
        .bind(hash(&raw))
        .bind(mail)
        .bind(&csrf)
        .bind(now() + 86400 * 7)
        .bind(expected_password)
        .bind(mail)
        .bind(expected_password)
        .execute(&app.db)
        .await?;
    if inserted.rows_affected() != 1 {
        return Err(Error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "set-cookie",
        format!(
            "hub_session={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{}",
            if app.secure { "; Secure" } else { "" }
        )
        .parse()
        .unwrap(),
    );
    Ok((
        headers,
        Json(
            json!({"email":mail,"csrf":csrf,"hub_address":app.origin,"is_admin":crate::admin::is_admin(app,mail)}),
        ),
    ))
}
static PASSWORD_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
pub async fn password_hash(password: String) -> Result<String> {
    if password.len() < 12 || password.len() > 256 {
        return Err(Error(StatusCode::BAD_REQUEST, "password_length"));
    }
    let permit = PASSWORD_WORKERS
        .try_acquire()
        .map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS, "rate_limit"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        use argon2::{
            password_hash::{rand_core::OsRng, SaltString},
            Argon2, PasswordHasher,
        };
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(|_| bad())
    })
    .await
    .map_err(|_| bad())?
}
pub async fn password_verify(password: String, encoded: String) -> bool {
    if password.len() > 256 {
        return false;
    }
    let Ok(permit) = PASSWORD_WORKERS.try_acquire() else {
        return false;
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        use argon2::{Argon2, PasswordHash, PasswordVerifier};
        PasswordHash::new(&encoded)
            .map(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn email_normalization_preserves_aliases() {
        assert_eq!(
            email(" User.Name+Work@Example.COM ").unwrap(),
            "user.name+work@example.com"
        );
        assert!(email("bad\n@example.com").is_err());
        assert!(email("missing").is_err());
    }
    #[tokio::test]
    async fn stale_password_cannot_create_session() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../../migrations").run(&db).await.unwrap();
        let app = App {
            admin: std::sync::Arc::new(crate::admin::Admin::new(crate::config::Runtime {
                home: std::env::temp_dir(),
                config: crate::config::Config {
                    admin_email: "owner@example.test".into(),
                    resend_api_key: "test".into(),
                },
            })),
            db,
            origin: "https://hub.test".into(),
            secure: true,
            dev: true,
            devices: Default::default(),
            rates: Default::default(),
            http: reqwest::Client::new(),
        };
        sqlx::query("INSERT INTO users(email,password) VALUES('owner@example.test','new-hash')")
            .execute(&app.db)
            .await
            .unwrap();
        assert!(login_checked(&app, "owner@example.test", Some("old-hash"))
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(&app.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(login_checked(&app, "owner@example.test", Some("new-hash"))
            .await
            .is_ok());
    }
    #[tokio::test]
    async fn password_roundtrip() {
        let h = password_hash("a strong test password".into())
            .await
            .unwrap();
        assert!(password_verify("a strong test password".into(), h.clone()).await);
        assert!(!password_verify("incorrect".into(), h).await);
        assert!(password_hash("short".into()).await.is_err());
    }
}
