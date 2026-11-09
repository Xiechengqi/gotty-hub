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
use rand::Rng;
use serde_json::{json, Value};
use sqlx::Row;

async fn challenge(app: &App, mail: &str, purpose: &str) -> Result<String> {
    limit(app, format!("mail:{mail}"), 5).await?;
    let id = token();
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1000000));
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO challenges(id,email,purpose,code,expires) VALUES(?,?,?,?,?)")
        .bind(&id)
        .bind(mail)
        .bind(purpose)
        .bind(hash(&format!("{id}:{code}")))
        .bind(now() + 600)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO outbox(email,body,expires) VALUES(?,?,?)").bind(mail).bind(format!("GoTTY Hub {purpose}: {code}\nExpires in 10 minutes. If you did not request this, ignore it.")).bind(now()+600).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}
async fn consume(app: &App, id: &str, code: &str, purpose: &str) -> Result<String> {
    let row=sqlx::query("UPDATE challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND expires>? AND attempts<5 RETURNING email,code").bind(id).bind(purpose).bind(now()).fetch_optional(&app.db).await?.ok_or(bad())?;
    if row.get::<String, _>("code") != hash(&format!("{id}:{code}")) {
        return Err(bad());
    }
    let n = sqlx::query("UPDATE challenges SET expires=0 WHERE id=? AND expires>? AND code=?")
        .bind(id)
        .bind(now())
        .bind(row.get::<String, _>("code"))
        .execute(&app.db)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(bad());
    }
    Ok(row.get("email"))
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().filter(|s| s.len() <= 1024).ok_or(bad())
}
pub async fn otp_request(State(app): State<App>, Json(v): Json<Value>) -> Result<Json<Value>> {
    let mail = email(field(&v, "email")?)?;
    let purpose = v["purpose"].as_str().unwrap_or("login");
    if !["login", "reset"].contains(&purpose) {
        return Err(bad());
    }
    limit(&app, "otp-global".into(), 200).await?;
    let id = challenge(&app, &mail, purpose).await?;
    Ok(Json(json!({"challenge":id})))
}
pub async fn otp_verify(State(app): State<App>, Json(v): Json<Value>) -> Result<impl IntoResponse> {
    let mail = consume(&app, field(&v, "challenge")?, field(&v, "code")?, "login").await?;
    login(&app, &mail).await
}
pub async fn password_login(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<impl IntoResponse> {
    let mail = email(field(&v, "email")?)?;
    limit(&app, format!("login:{mail}"), 10).await?;
    limit(&app, "password-global".into(), 100).await?;
    let encoded: Option<String> = sqlx::query_scalar("SELECT password FROM users WHERE email=?")
        .bind(&mail)
        .fetch_optional(&app.db)
        .await?
        .flatten();
    // A valid dummy hash avoids skipping the expensive verification for unknown accounts.
    let encoded=encoded.unwrap_or_else(||"$argon2id$v=19$m=19456,t=2,p=1$U29tZVN0YXRpY1NhbHQxMg$QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI".into());
    if !password_verify(field(&v, "password")?.into(), encoded.clone()).await {
        return Err(Error(
            axum::http::StatusCode::UNAUTHORIZED,
            "invalid_credentials",
        ));
    }
    login_checked(&app, &mail, Some(&encoded)).await
}
pub async fn verify_reset(State(app): State<App>, Json(v): Json<Value>) -> Result<Json<Value>> {
    let id = field(&v, "challenge")?;
    let code = field(&v, "code")?;
    let row=sqlx::query("UPDATE challenges SET attempts=attempts+1 WHERE id=? AND purpose='reset' AND expires>? AND attempts<5 RETURNING code").bind(id).bind(now()).fetch_optional(&app.db).await?.ok_or(bad())?;
    if row.get::<String, _>("code") != hash(&format!("{id}:{code}")) {
        return Err(bad());
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn password_reset(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<impl IntoResponse> {
    let encoded = password_hash(field(&v, "password")?.into()).await?;
    let mail = consume(&app, field(&v, "challenge")?, field(&v, "code")?, "reset").await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO users(email,password) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET password=excluded.password").bind(&mail).bind(encoded).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE email=?")
        .bind(&mail)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    notify_password(&app, &mail).await;
    login(&app, &mail).await
}
pub async fn me(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    Ok(Json(
        json!({"email":s.email,"csrf":s.csrf,"hub_address":app.origin,"is_admin":crate::admin::is_admin(&app,&s.email)}),
    ))
}
pub async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    sqlx::query("DELETE FROM sessions WHERE token=?")
        .bind(s.key)
        .execute(&app.db)
        .await?;
    audit(&app, &s.email, "logout", "").await;
    Ok(Json(json!({"ok":true})))
}
pub async fn logout_all(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    sqlx::query("DELETE FROM sessions WHERE email=?")
        .bind(s.email)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn sessions(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    let r = sqlx::query("SELECT expires FROM sessions WHERE email=? AND expires>?")
        .bind(s.email)
        .bind(now())
        .fetch_all(&app.db)
        .await?;
    Ok(Json(
        json!({"sessions":r.into_iter().map(|r|json!({"expires":r.get::<i64,_>("expires")})).collect::<Vec<_>>()}),
    ))
}
pub async fn change_password(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<impl IntoResponse> {
    let s = session(&app, &h).await?;
    let encoded = password_hash(field(&v, "password")?.into()).await?;
    let mut tx = app.db.begin().await?;
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token=? AND expires>?)")
            .bind(&s.key)
            .bind(now())
            .fetch_one(&mut *tx)
            .await?;
    if !valid {
        return Err(denied());
    }
    sqlx::query("UPDATE users SET password=? WHERE email=?")
        .bind(encoded)
        .bind(&s.email)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE email=?")
        .bind(&s.email)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    notify_password(&app, &s.email).await;
    login(&app, &s.email).await
}
pub async fn preferences(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM preferences WHERE email=?")
        .bind(s.email)
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
        "INSERT INTO preferences VALUES(?,?) ON CONFLICT(email) DO UPDATE SET value=excluded.value",
    )
    .bind(s.email)
    .bind(v.to_string())
    .execute(&app.db)
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn instance_list(app: &App, mail: &str) -> Result<Value> {
    let rows=sqlx::query("SELECT i.id,i.name,g.role FROM instances i JOIN grants g ON i.id=g.instance WHERE g.email=? ORDER BY i.name,i.id").bind(mail).fetch_all(&app.db).await?;
    let devices = app.devices.lock().await;
    Ok(Value::Array(rows.into_iter().map(|r|{let id:String=r.get("id");let d=devices.get(&id);json!({"id":id,"name":r.get::<String,_>("name"),"role":r.get::<String,_>("role"),"online":d.is_some(),"status":d.map(|d|d.color.clone()).unwrap_or_else(||"offline".into()),"capabilities":d.map(|d|d.capabilities.clone()).unwrap_or(json!({})),"revision":d.map(|d|d.revision).unwrap_or(0)})}).collect()))
}
pub async fn instances(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let s = session(&app, &h).await?;
    Ok(Json(instance_list(&app, &s.email).await?))
}
pub async fn owner(app: &App, h: &HeaderMap, id: &str) -> Result<Session> {
    let s = session(app, h).await?;
    let owner: Option<String> = sqlx::query_scalar("SELECT owner FROM instances WHERE id=?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?;
    if owner.as_deref() != Some(&s.email) {
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
    let rows = sqlx::query("SELECT email,role FROM grants WHERE instance=? ORDER BY email")
        .bind(id)
        .fetch_all(&app.db)
        .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|r| json!({"email":r.get::<String,_>("email"),"role":r.get::<String,_>("role")}))
        .collect::<Vec<_>>())))
}
pub async fn set_grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let s = owner(&app, &h, &id).await?;
    let mail = email(field(&v, "email")?)?;
    let role = field(&v, "role")?;
    if !["operator", "observer"].contains(&role) || mail == s.email {
        return Err(bad());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO grants VALUES(?,?,?) ON CONFLICT(instance,email) DO UPDATE SET role=excluded.role").bind(&id).bind(&mail).bind(role).execute(&mut *tx).await?;
    sqlx::query("UPDATE instances SET version=version+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&app, &s.email, "grant", &id).await;
    Ok(Json(json!({"ok":true})))
}
pub async fn remove_grant(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, mail)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let s = owner(&app, &h, &id).await?;
    if email(&mail)? == s.email {
        return Err(bad());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("DELETE FROM grants WHERE instance=? AND email=?")
        .bind(&id)
        .bind(mail)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE instances SET version=version+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&app, &s.email, "revoke", &id).await;
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
    audit(&app, &s.email, "unbind", &id).await;
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
pub async fn enroll(State(app): State<App>, Json(v): Json<Value>) -> Result<Json<Value>> {
    limit(&app, "enroll-global".into(), 100).await?;
    let mail = email(field(&v, "email")?)?;
    let claim = field(&v, "claim")?;
    if claim.len() != 64 {
        return Err(bad());
    }
    let name = field(&v, "name")?.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(bad());
    }
    let challenge = challenge(&app, &mail, "enrollment").await?;
    let id = token();
    let initial = v["grants"].as_array().cloned().unwrap_or_default();
    if initial.len() > 50 {
        return Err(bad());
    }
    let mut grants = Vec::new();
    for item in initial {
        let mail = email(item["email"].as_str().ok_or(bad())?)?;
        let role = item["role"].as_str().unwrap_or("operator");
        if !["operator", "observer"].contains(&role) {
            return Err(bad());
        }
        grants.push(json!({"email":mail,"role":role}));
    }
    sqlx::query("INSERT INTO enrollments(id,name,email,claim,challenge,expires,initial_grants) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(name).bind(mail).bind(hash(claim)).bind(challenge).bind(now()+600).bind(json!(grants).to_string()).execute(&app.db).await?;
    Ok(Json(json!({"id":id,"expires_in":600})))
}
pub async fn confirm(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let r = sqlx::query("SELECT * FROM enrollments WHERE id=? AND expires>?")
        .bind(&id)
        .bind(now())
        .fetch_optional(&app.db)
        .await?
        .ok_or(bad())?;
    let claim = field(&v, "claim")?;
    if r.get::<String, _>("claim") != hash(claim) {
        return Err(denied());
    }
    if let Some(instance) = r.get::<Option<String>, _>("confirmed_instance") {
        return Ok(Json(
            json!({"instance_id":instance,"credential":hash(&format!("credential:{claim}:{instance}")),"protocol":1}),
        ));
    }
    let challenge: String = r.get("challenge");
    let code = field(&v, "code")?;
    let checked=sqlx::query("UPDATE challenges SET attempts=attempts+1 WHERE id=? AND expires>? AND attempts<5 RETURNING code").bind(&challenge).bind(now()).fetch_optional(&app.db).await?.ok_or(bad())?;
    if checked.get::<String, _>("code") != hash(&format!("{challenge}:{code}")) {
        return Err(bad());
    }
    let mut tx = app.db.begin().await?;
    let consumed =
        sqlx::query("UPDATE challenges SET expires=0 WHERE id=? AND expires>? AND code=?")
            .bind(&challenge)
            .bind(now())
            .bind(hash(&format!("{challenge}:{code}")))
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if consumed != 1 {
        return Err(bad());
    }
    let mail: String = r.get("email");
    let instance = token();
    let device = hash(&format!("credential:{claim}:{instance}"));
    sqlx::query("INSERT OR IGNORE INTO users(email) VALUES(?)")
        .bind(&mail)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO instances(id,name,owner,device) VALUES(?,?,?,?)")
        .bind(&instance)
        .bind(r.get::<String, _>("name"))
        .bind(&mail)
        .bind(hash(&device))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO grants VALUES(?,?,?)")
        .bind(&instance)
        .bind(&mail)
        .bind("owner")
        .execute(&mut *tx)
        .await?;
    let initial: Vec<Value> =
        serde_json::from_str(&r.get::<String, _>("initial_grants")).unwrap_or_default();
    for grant in initial {
        if grant["email"] != mail {
            sqlx::query("INSERT OR IGNORE INTO grants VALUES(?,?,?)")
                .bind(&instance)
                .bind(grant["email"].as_str().ok_or(bad())?)
                .bind(grant["role"].as_str().ok_or(bad())?)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("UPDATE enrollments SET confirmed_instance=? WHERE id=?")
        .bind(&instance)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&app, &mail, "enroll", &instance).await;
    Ok(Json(
        json!({"instance_id":instance,"credential":device,"protocol":1}),
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
        let v = instance_list(&app, &s.email).await.ok()?;
        Some((
            Ok::<_, std::convert::Infallible>(
                Event::default().event("instances").data(v.to_string()),
            ),
            (app, s),
        ))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
async fn notify_password(app: &App, mail: &str) {
    audit(app, mail, "password_changed", "").await;
    let _=sqlx::query("INSERT INTO outbox(email,body,expires) VALUES(?,?,?)").bind(mail).bind("Your GoTTY Hub password was changed. Previous login sessions were revoked. If this was not you, reset your password immediately.").bind(now()+86400).execute(&app.db).await;
}
pub async fn mail_worker(app: App) {
    loop {
        let rows=sqlx::query("SELECT id,email,body,attempts FROM outbox WHERE sent=0 AND expires>? AND next_attempt<=? AND attempts<5 ORDER BY id LIMIT 10").bind(now()).bind(now()).fetch_all(&app.db).await.unwrap_or_default();
        for r in rows {
            let id: i64 = r.get("id");
            let mail: String = r.get("email");
            let body: String = r.get("body");
            let attempts: i64 = r.get("attempts");
            let ok = if app.dev {
                let dir = std::env::var("HUB_DEV_MAIL_DIR").unwrap_or_else(|_| {
                    app.admin
                        .runtime
                        .home
                        .join("mail")
                        .to_string_lossy()
                        .into_owned()
                });
                (async {
                    tokio::fs::create_dir_all(&dir).await?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                            .await?;
                    }
                    tokio::fs::write(
                        format!("{dir}/{id}.json"),
                        json!({"to":mail,"text":body}).to_string(),
                    )
                    .await
                })
                .await
                .is_ok()
            } else {
                app.http.post("https://api.resend.com/emails").bearer_auth(&app.admin.runtime.config.resend_api_key).header("Idempotency-Key",hash(&format!("mail:{id}:{mail}:{body}"))).json(&json!({"from":std::env::var("HUB_MAIL_FROM").unwrap_or_else(|_|"GoTTY Hub <onboarding@resend.dev>".into()),"to":[mail],"subject":"GoTTY Hub verification","text":body})).send().await.map(|r|r.status().is_success()).unwrap_or(false)
            };
            let _=sqlx::query("UPDATE outbox SET sent=?,attempts=attempts+1,next_attempt=?,body=CASE WHEN ? THEN '' ELSE body END WHERE id=?").bind(ok).bind(now()+15*(1<<attempts)).bind(ok).bind(id).execute(&app.db).await;
        }
        let _ = sqlx::query("DELETE FROM outbox WHERE expires<?")
            .bind(now() - 86400)
            .execute(&app.db)
            .await;
        let _ = sqlx::query("DELETE FROM tickets WHERE expires<?")
            .bind(now())
            .execute(&app.db)
            .await;
        let _ = sqlx::query("DELETE FROM enrollments WHERE expires<?")
            .bind(now())
            .execute(&app.db)
            .await;
        let _=sqlx::query("DELETE FROM challenges WHERE expires<? AND id NOT IN (SELECT challenge FROM enrollments)").bind(now()).execute(&app.db).await;
        let _ = sqlx::query("DELETE FROM sessions WHERE expires<?")
            .bind(now())
            .execute(&app.db)
            .await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

pub async fn ready(State(app): State<App>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&app.db).await?;
    Ok(Json(json!({"ready":true})))
}
pub async fn diagnostics(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    session(&app, &h).await?;
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE sent=0 AND expires>?")
        .bind(now())
        .fetch_one(&app.db)
        .await?;
    let devices = app.devices.lock().await;
    let mut streams = 0;
    for d in devices.values() {
        streams += d.streams.lock().await.len()
    }
    Ok(Json(
        json!({"online_devices":devices.len(),"active_streams":streams,"pending_mail":pending}),
    ))
}
