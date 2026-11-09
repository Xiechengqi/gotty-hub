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
pub fn username(s: &str) -> Result<String> {
    let s = s.trim().to_ascii_lowercase();
    if !(3..=64).contains(&s.len())
        || !s.as_bytes()[0].is_ascii_alphanumeric()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_username"));
    }
    Ok(s)
}
pub fn validate_password(s: &str) -> Result<()> {
    if !(12..=256).contains(&s.len()) {
        return Err(Error(StatusCode::BAD_REQUEST, "password_length"));
    }
    Ok(())
}
pub fn secret(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
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
    pub user_id: String,
    pub username: String,
    pub is_admin: bool,
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
    let row = sqlx::query("SELECT s.user_id,u.username,u.is_admin,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?")
        .bind(&key)
        .bind(now())
        .fetch_optional(&app.db)
        .await?
        .ok_or(Error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    Ok(Session {
        key,
        user_id: row.get("user_id"),
        username: row.get("username"),
        is_admin: row.get("is_admin"),
        csrf: row.get("csrf"),
    })
}
pub fn request_origin(app: &App, headers: &HeaderMap) -> Result<String> {
    if let Some(origin) = &app.origin {
        return Ok(origin.clone());
    }
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(bad)?;
    let authority: axum::http::uri::Authority = host.parse().map_err(|_| bad())?;
    // The built-in listener serves HTTP. TLS proxies can pin their HTTPS origin
    // with HUB_ORIGIN; untrusted forwarding headers do not change this policy.
    crate::config::parse_origin(&format!("http://{authority}")).map_err(|_| bad())
}
pub fn check_origin(app: &App, headers: &HeaderMap, required: bool) -> Result<()> {
    let mismatch = || Error(StatusCode::FORBIDDEN, "origin_mismatch");
    match headers.get("origin") {
        Some(origin) => {
            let expected = request_origin(app, headers).map_err(|_| mismatch())?;
            if origin.to_str().ok() != Some(expected.as_str()) {
                return Err(mismatch());
            }
        }
        None if required => return Err(mismatch()),
        None => {}
    }
    Ok(())
}
pub async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path();
    let public = matches!(
        path,
        "/api/v1/auth/register"
            | "/api/v1/auth/password/login"
            | "/api/v1/instances/register"
            | "/connector/v1/name"
    );
    if public {
        let ip = request
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|v| v.0.ip().to_string())
            .unwrap_or_else(|| "local".into());
        if let Err(e) = limit(&app, format!("public:{ip}"), 100).await {
            return e.into_response();
        }
    }
    if let Err(error) = check_origin(&app, request.headers(), false) {
        return error.into_response();
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
        if !public {
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
pub fn account(s: &Session, origin: &str) -> Value {
    json!({"id":s.user_id,"username":s.username,"csrf":s.csrf,"hub_address":origin,"is_admin":s.is_admin})
}
pub async fn login_checked(
    app: &App,
    user_id: &str,
    expected_password: &str,
    request_headers: &HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    let origin = request_origin(app, request_headers)?;
    let raw = token();
    let csrf = token();
    let inserted=sqlx::query("INSERT INTO sessions(token,user_id,csrf,expires) SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=?")
        .bind(hash(&raw)).bind(&csrf).bind(now()+86400*7).bind(user_id).bind(expected_password).execute(&app.db).await?;
    if inserted.rows_affected() != 1 {
        return Err(Error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let row = sqlx::query("SELECT username,is_admin FROM users WHERE id=?")
        .bind(user_id)
        .fetch_one(&app.db)
        .await?;
    let s = Session {
        key: hash(&raw),
        user_id: user_id.into(),
        username: row.get("username"),
        is_admin: row.get("is_admin"),
        csrf,
    };
    crate::api::audit(app, &s.username, "login", "").await;
    let mut headers = HeaderMap::new();
    headers.insert(
        "set-cookie",
        format!(
            "hub_session={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{}",
            if origin.starts_with("https://") {
                "; Secure"
            } else {
                ""
            }
        )
        .parse()
        .unwrap(),
    );
    Ok((headers, Json(account(&s, &origin))))
}
pub async fn sync_admin(db: &sqlx::SqlitePool, password: &str) -> anyhow::Result<()> {
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id,password_hash FROM users WHERE username='admin'")
            .fetch_optional(db)
            .await?;
    if let Some((id, encoded)) = existing {
        if !password_verify(password.into(), encoded).await {
            let encoded = password_hash(password.into())
                .await
                .map_err(|_| anyhow::anyhow!("Cannot hash admin password"))?;
            let mut tx = db.begin().await?;
            sqlx::query("UPDATE users SET password_hash=?,is_admin=1 WHERE id=?")
                .bind(encoded)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM sessions WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
    } else {
        let encoded = password_hash(password.into())
            .await
            .map_err(|_| anyhow::anyhow!("Cannot hash admin password"))?;
        sqlx::query(
            "INSERT INTO users(id,username,password_hash,is_admin,created) VALUES(?,'admin',?,1,?)",
        )
        .bind(token())
        .bind(encoded)
        .bind(now())
        .execute(db)
        .await?;
    }
    Ok(())
}
static PASSWORD_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
pub async fn password_hash(password: String) -> Result<String> {
    if !crate::config::valid_admin_password(&password) {
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
    fn username_normalization() {
        assert_eq!(username(" User.Name-01 ").unwrap(), "user.name-01");
        for value in ["ab", "bad name", "bad@example.test", "-name", "用户"] {
            assert!(username(value).is_err());
        }
    }
    #[tokio::test]
    async fn password_roundtrip() {
        let h = password_hash("a strong test password".into())
            .await
            .unwrap();
        assert!(password_verify("a strong test password".into(), h.clone()).await);
        assert!(!password_verify("incorrect".into(), h).await);
        assert!(password_hash(" ".into()).await.is_err());
        assert!(validate_password("short").is_err());
    }
}
