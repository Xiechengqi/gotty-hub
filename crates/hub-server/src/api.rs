use crate::{gateway, security::*, App};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use serde_json::{json, Value};
use sqlx::Row;

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().filter(|s| s.len() <= 1024).ok_or(bad())
}
pub async fn register(State(app): State<App>, Json(v): Json<Value>) -> Result<impl IntoResponse> {
    let name = username(field(&v, "username")?)?;
    if name == "admin" {
        return Err(Error(axum::http::StatusCode::CONFLICT, "username_taken"));
    }
    limit(&app, "register-global".into(), 100).await?;
    let password = field(&v, "password")?;
    validate_password(password)?;
    let encoded = password_hash(password.into()).await?;
    let id = token();
    let inserted=sqlx::query("INSERT INTO users(id,username,password_hash,created) VALUES(?,?,?,?) ON CONFLICT(username) DO NOTHING")
        .bind(&id).bind(&name).bind(&encoded).bind(now()).execute(&app.db).await?;
    if inserted.rows_affected() != 1 {
        return Err(Error(axum::http::StatusCode::CONFLICT, "username_taken"));
    }
    audit(&app, &name, "register", "").await;
    login_checked(&app, &id, &encoded).await
}
pub async fn password_login(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<impl IntoResponse> {
    let name = username(field(&v, "username")?)?;
    limit(&app, format!("login:{name}"), 10).await?;
    limit(&app, "password-global".into(), 100).await?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id,password_hash FROM users WHERE username=?")
            .bind(name)
            .fetch_optional(&app.db)
            .await?;
    let (id,encoded)=row.unwrap_or_else(||(String::new(),"$argon2id$v=19$m=19456,t=2,p=1$U29tZVN0YXRpY1NhbHQxMg$QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI".into()));
    if !password_verify(field(&v, "password")?.into(), encoded.clone()).await || id.is_empty() {
        return Err(Error(
            axum::http::StatusCode::UNAUTHORIZED,
            "invalid_credentials",
        ));
    }
    login_checked(&app, &id, &encoded).await
}
pub async fn me(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    Ok(Json(account(&app, &s)))
}
pub async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    sqlx::query("DELETE FROM sessions WHERE token=?")
        .bind(s.key)
        .execute(&app.db)
        .await?;
    audit(&app, &s.username, "logout", "").await;
    Ok(Json(json!({"ok":true})))
}
pub async fn logout_all(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(s.user_id)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn sessions(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    let r = sqlx::query("SELECT expires FROM sessions WHERE user_id=? AND expires>?")
        .bind(s.user_id)
        .bind(now())
        .fetch_all(&app.db)
        .await?;
    Ok(Json(
        json!({"sessions":r.into_iter().map(|r|json!({"expires":r.get::<i64,_>("expires")})).collect::<Vec<_>>()}),
    ))
}
async fn set_password(
    app: &App,
    id: &str,
    name: &str,
    password: &str,
    session_key: Option<&str>,
) -> Result<String> {
    let _guard = app.admin.credentials.lock().await;
    if name != "admin" {
        validate_password(password)?;
    }
    let encoded = password_hash(password.into()).await?;
    let mut tx = app.db.begin().await?;
    if let Some(key) = session_key {
        let valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token=? AND expires>?)")
                .bind(key)
                .bind(now())
                .fetch_one(&mut *tx)
                .await?;
        if !valid {
            return Err(Error(
                axum::http::StatusCode::UNAUTHORIZED,
                "authentication_required",
            ));
        }
    }
    sqlx::query("UPDATE users SET password_hash=? WHERE id=?")
        .bind(&encoded)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let config_path = app.admin.runtime.home.join("config");
    let previous = if name == "admin" {
        let previous = std::fs::read(&config_path).map_err(|_| {
            Error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "config_write_failed",
            )
        })?;
        let config = crate::config::Config {
            password: password.into(),
        };
        crate::config::save(
            &config_path,
            &serde_json::to_vec_pretty(&config).map_err(|_| bad())?,
        )
        .map_err(|_| {
            Error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "config_write_failed",
            )
        })?;
        Some(previous)
    } else {
        None
    };
    if let Err(error) = tx.commit().await {
        if let Some(previous) = previous {
            if crate::config::save(&config_path, &previous).is_err() {
                tracing::error!("Failed to restore admin config after database commit failure");
            }
        }
        return Err(error.into());
    }
    audit(app, name, "password_changed", "").await;
    Ok(encoded)
}
pub async fn reset_password_local(app: &App, name: &str, password: &str) -> Result<()> {
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username=?")
        .bind(name)
        .fetch_optional(&app.db)
        .await?;
    let id = id.ok_or(Error(axum::http::StatusCode::NOT_FOUND, "user_not_found"))?;
    set_password(app, &id, name, password, None).await?;
    Ok(())
}
pub async fn change_password(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<impl IntoResponse> {
    let s = session(&app, &h).await?;
    let encoded = set_password(
        &app,
        &s.user_id,
        &s.username,
        field(&v, "password")?,
        Some(&s.key),
    )
    .await?;
    login_checked(&app, &s.user_id, &encoded).await
}
pub async fn preferences(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM preferences WHERE user_id=?")
        .bind(s.user_id)
        .fetch_optional(&app.db)
        .await?;
    Ok(Json(
        v.and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({})),
    ))
}
pub async fn save_preferences(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    if v.to_string().len() > 16384 {
        return Err(bad());
    }
    sqlx::query(
        "INSERT INTO preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value",
    )
    .bind(s.user_id)
    .bind(v.to_string())
    .execute(&app.db)
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn instance_list(app: &App, user_id: &str) -> Result<Value> {
    let rows=sqlx::query("SELECT i.id,i.name,g.role FROM instances i JOIN grants g ON i.id=g.instance WHERE g.user_id=? ORDER BY i.name,i.id").bind(user_id).fetch_all(&app.db).await?;
    let devices = app.devices.lock().await;
    Ok(Value::Array(rows.into_iter().map(|r|{let id:String=r.get("id");let d=devices.get(&id);json!({"id":id,"name":r.get::<String,_>("name"),"role":r.get::<String,_>("role"),"online":d.is_some(),"status":d.map(|d|d.color.clone()).unwrap_or_else(||"offline".into()),"capabilities":d.map(|d|d.capabilities.clone()).unwrap_or(json!({})),"revision":d.map(|d|d.revision).unwrap_or(0)})}).collect()))
}
pub async fn instances(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    Ok(Json(instance_list(&app, &s.user_id).await?))
}
pub async fn owner(app: &App, h: &HeaderMap, id: &str) -> Result<Session> {
    let s = session(app, h).await?;
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM instances WHERE id=?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?;
    if owner.as_deref() != Some(&s.user_id) {
        return Err(denied());
    }
    Ok(s)
}
pub async fn grants(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    owner(&app, &h, &id).await?;
    let rows = sqlx::query("SELECT u.username,g.role FROM grants g JOIN users u ON u.id=g.user_id WHERE instance=? ORDER BY u.username")
        .bind(id)
        .fetch_all(&app.db)
        .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|r| json!({"username":r.get::<String,_>("username"),"role":r.get::<String,_>("role")}))
        .collect::<Vec<_>>())))
}
pub async fn set_grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let s = owner(&app, &h, &id).await?;
    let name = username(field(&v, "username")?)?;
    let user_id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username=?")
        .bind(&name)
        .fetch_optional(&app.db)
        .await?;
    let user_id = user_id.ok_or(Error(axum::http::StatusCode::NOT_FOUND, "user_not_found"))?;
    let role = field(&v, "role")?;
    if !["operator", "observer"].contains(&role) || user_id == s.user_id {
        return Err(bad());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO grants VALUES(?,?,?) ON CONFLICT(instance,user_id) DO UPDATE SET role=excluded.role").bind(&id).bind(&user_id).bind(role).execute(&mut *tx).await?;
    sqlx::query("UPDATE instances SET version=version+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&app, &s.username, "grant", &id).await;
    Ok(Json(json!({"ok":true})))
}
pub async fn remove_grant(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, name)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let s = owner(&app, &h, &id).await?;
    let name = username(&name)?;
    if name == s.username {
        return Err(bad());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "DELETE FROM grants WHERE instance=? AND user_id=(SELECT id FROM users WHERE username=?)",
    )
    .bind(&id)
    .bind(name)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE instances SET version=version+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&app, &s.username, "revoke", &id).await;
    Ok(Json(json!({"ok":true})))
}
pub async fn unbind(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let s = owner(&app, &h, &id).await?;
    sqlx::query("DELETE FROM instances WHERE id=?")
        .bind(&id)
        .execute(&app.db)
        .await?;
    if let Some(d) = app.devices.lock().await.remove(&id) {
        let _ =
            d.tx.try_send(hub_protocol::Frame::new("revoked", "", json!({})));
    }
    audit(&app, &s.username, "unbind", &id).await;
    Ok(Json(json!({"ok":true})))
}
pub async fn rotate(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    owner(&app, &h, &id).await?;
    let devices = app.devices.lock().await;
    let d = devices.get(&id).ok_or(bad())?;
    let raw = token();
    let changed = sqlx::query(
        "UPDATE instances SET device_next=?,version=version+1 WHERE id=? AND device_next IS NULL",
    )
    .bind(hash(&raw))
    .bind(&id)
    .execute(&app.db)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(Error(axum::http::StatusCode::CONFLICT, "rotation_pending"));
    }
    if d.tx
        .try_send(hub_protocol::Frame::new(
            "rotate",
            "",
            json!({"credential":raw}),
        ))
        .is_err()
    {
        sqlx::query("UPDATE instances SET device_next=NULL WHERE id=? AND device_next=?")
            .bind(&id)
            .bind(hash(&raw))
            .execute(&app.db)
            .await?;
        return Err(bad());
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn ticket(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    gateway::new_ticket(&app, &s, &id).await
}
pub async fn register_instance(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    limit(&app, "device-register-global".into(), 100).await?;
    let name = username(field(&v, "username")?)?;
    let user_id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username=?")
        .bind(&name)
        .fetch_optional(&app.db)
        .await?;
    let user_id = user_id.ok_or(Error(axum::http::StatusCode::NOT_FOUND, "user_not_found"))?;
    let request_id = field(&v, "request_id")?;
    let claim = field(&v, "claim")?;
    let title = field(&v, "name")?.trim();
    if !secret(request_id) || !secret(claim) || title.is_empty() || title.len() > 80 {
        return Err(bad());
    }
    let instance = token();
    let mut tx = app.db.begin().await?;
    // Acquire the SQLite writer before reading the idempotency record.
    let inserted=sqlx::query("INSERT INTO registrations(id,user_id,claim,instance_id) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .bind(request_id).bind(&user_id).bind(hash(claim)).bind(&instance).execute(&mut *tx).await?.rows_affected()==1;
    let instance = if inserted {
        let device = hash(&format!("credential:{claim}:{instance}"));
        sqlx::query("INSERT INTO instances(id,name,owner_id,device) VALUES(?,?,?,?)")
            .bind(&instance)
            .bind(title)
            .bind(&user_id)
            .bind(hash(&device))
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO grants(instance,user_id,role) VALUES(?,?,'owner')")
            .bind(&instance)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        instance
    } else {
        let row = sqlx::query("SELECT user_id,claim,instance_id FROM registrations WHERE id=?")
            .bind(request_id)
            .fetch_one(&mut *tx)
            .await?;
        if row.get::<String, _>("user_id") != user_id
            || row.get::<String, _>("claim") != hash(claim)
        {
            return Err(denied());
        }
        let instance: String = row.get("instance_id");
        let device: Option<String> =
            sqlx::query_scalar("SELECT device FROM instances WHERE id=? AND device_next IS NULL")
                .bind(&instance)
                .fetch_optional(&mut *tx)
                .await?;
        if device.as_deref() != Some(&hash(&hash(&format!("credential:{claim}:{instance}")))) {
            return Err(Error(
                axum::http::StatusCode::CONFLICT,
                "registration_expired",
            ));
        }
        instance
    };
    tx.commit().await?;
    if inserted {
        audit(&app, &name, "device_registered", &instance).await;
    }
    Ok(Json(
        json!({"instance_id":instance,"credential":hash(&format!("credential:{claim}:{instance}")),"protocol":1}),
    ))
}
pub(crate) async fn audit(app: &App, actor: &str, action: &str, id: &str) {
    let _ = sqlx::query("INSERT INTO audit(at,actor,action,instance) VALUES(?,?,?,?)")
        .bind(now())
        .bind(actor)
        .bind(action)
        .bind(id)
        .execute(&app.db)
        .await;
}
pub async fn events(State(app): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let s = session(&app, &h).await?;
    let stream = futures_util::stream::unfold((app, s), |(app, s)| async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let valid: Option<i64> =
            sqlx::query_scalar("SELECT expires FROM sessions WHERE token=? AND expires>?")
                .bind(&s.key)
                .bind(now())
                .fetch_optional(&app.db)
                .await
                .ok()
                .flatten();
        valid?;
        let v = instance_list(&app, &s.user_id).await.ok()?;
        Some((
            Ok::<_, std::convert::Infallible>(
                Event::default().event("instances").data(v.to_string()),
            ),
            (app, s),
        ))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
pub async fn cleanup_worker(app: App) {
    loop {
        for table in ["sessions", "tickets"] {
            let _ = sqlx::query(&format!("DELETE FROM {table} WHERE expires<?"))
                .bind(now())
                .execute(&app.db)
                .await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

pub async fn ready(State(app): State<App>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&app.db).await?;
    Ok(Json(json!({"ready":true})))
}
pub async fn diagnostics(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    session(&app, &h).await?;
    let devices = app.devices.lock().await;
    let mut streams = 0;
    for d in devices.values() {
        streams += d.streams.lock().await.len()
    }
    Ok(Json(
        json!({"online_devices":devices.len(),"active_streams":streams}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn app() -> App {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../../migrations").run(&db).await.unwrap();
        App {
            admin: std::sync::Arc::new(crate::admin::Admin::new(crate::config::Runtime {
                home: std::env::temp_dir().join(token()),
                config: crate::config::Config {
                    password: "test admin password".into(),
                },
                reset_password: None,
            })),
            db,
            origin: "https://hub.test".into(),
            secure: true,
            devices: Default::default(),
            rates: Default::default(),
            http: reqwest::Client::new(),
        }
    }
    async fn user(app: &App, name: &str) -> String {
        let id = token();
        sqlx::query("INSERT INTO users(id,username,password_hash,created) VALUES(?,?,?,?)")
            .bind(&id)
            .bind(name)
            .bind("new-hash")
            .bind(now())
            .execute(&app.db)
            .await
            .unwrap();
        id
    }
    #[tokio::test]
    async fn public_registration_cannot_create_an_administrator() {
        let app = app().await;
        let result=register(State(app.clone()),Json(json!({"username":"normal-user","password":"a normal test password","is_admin":true}))).await.unwrap().into_response();
        assert_eq!(result.status(), axum::http::StatusCode::OK);
        let admin: bool =
            sqlx::query_scalar("SELECT is_admin FROM users WHERE username='normal-user'")
                .fetch_one(&app.db)
                .await
                .unwrap();
        assert!(!admin);
        assert!(matches!(
            register(
                State(app),
                Json(json!({"username":"ADMIN","password":"a normal test password"}))
            )
            .await,
            Err(Error(axum::http::StatusCode::CONFLICT, "username_taken"))
        ));
    }
    #[tokio::test]
    async fn login_requires_existing_user_and_current_hash() {
        let app = app().await;
        let id = user(&app, "owner").await;
        assert!(login_checked(&app, &id, "old-hash").await.is_err());
        assert!(login_checked(&app, "missing", "new-hash").await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(&app.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(login_checked(&app, &id, "new-hash").await.is_ok());
    }
    #[tokio::test]
    async fn device_registration_requires_registered_user() {
        let app = app().await;
        let error = register_instance(
            State(app.clone()),
            Json(
                json!({"username":"missing","name":"device","request_id":token(),"claim":token()}),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.1, "user_not_found");
        for table in ["users", "instances", "registrations"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&app.db)
                .await
                .unwrap();
            assert_eq!(count, 0);
        }
    }
    #[tokio::test]
    async fn registration_is_idempotent_and_cannot_reclaim_rotated_or_revoked_devices() {
        let app = app().await;
        let owner = user(&app, "owner").await;
        user(&app, "other").await;
        let payload =
            json!({"username":"OWNER","name":"device","request_id":token(),"claim":token()});
        let (a, b) = tokio::join!(
            register_instance(State(app.clone()), Json(payload.clone())),
            register_instance(State(app.clone()), Json(payload.clone()))
        );
        let a = a.unwrap().0;
        assert_eq!(a, b.unwrap().0);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM instances WHERE owner_id=?")
            .bind(owner)
            .fetch_one(&app.db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let mut stolen = payload.clone();
        stolen["username"] = json!("other");
        assert_eq!(
            register_instance(State(app.clone()), Json(stolen))
                .await
                .unwrap_err()
                .0,
            axum::http::StatusCode::FORBIDDEN
        );
        let mut wrong = payload.clone();
        wrong["claim"] = json!(token());
        assert_eq!(
            register_instance(State(app.clone()), Json(wrong))
                .await
                .unwrap_err()
                .0,
            axum::http::StatusCode::FORBIDDEN
        );
        let id = a["instance_id"].as_str().unwrap();
        sqlx::query("UPDATE instances SET device=? WHERE id=?")
            .bind(hash(&token()))
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
        assert_eq!(
            register_instance(State(app.clone()), Json(payload.clone()))
                .await
                .unwrap_err()
                .1,
            "registration_expired"
        );
        sqlx::query("DELETE FROM instances WHERE id=?")
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
        assert_eq!(
            register_instance(State(app.clone()), Json(payload))
                .await
                .unwrap_err()
                .1,
            "registration_expired"
        );
    }
}
