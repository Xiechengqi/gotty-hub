mod admin;
mod api;
mod assets;
mod config;
mod gateway;
mod security;
use axum::{
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use sqlx::sqlite::SqlitePoolOptions;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};
#[derive(Clone)]
pub struct App {
    pub admin: Arc<admin::Admin>,
    pub db: sqlx::SqlitePool,
    pub origin: Option<String>,
    pub secure: bool,
    pub devices: Arc<Mutex<HashMap<String, gateway::Device>>>,
    pub rates: Arc<Mutex<HashMap<String, (u64, u32)>>>,
    pub http: reqwest::Client,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let Some(runtime) = config::load()? else {
        return Ok(());
    };
    let log_dir = runtime.home.join("logs");
    config::private_dir(&log_dir)?;
    let log = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("hub.log")
        .max_log_files(7)
        .build(&log_dir)?;
    let (writer, _log_guard) = tracing_appender::non_blocking(log);
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("gotty_hub=info"))
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        )
        .init();
    let origin = std::env::var("HUB_ORIGIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| config::parse_origin(&value))
        .transpose()?;
    let url = std::env::var("HUB_DATABASE").unwrap_or_else(|_| {
        format!(
            "sqlite://{}?mode=rwc",
            runtime.home.join("hub.db").display()
        )
    });
    let options: sqlx::sqlite::SqliteConnectOptions = url.parse()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = options.get_filename();
        if path.to_string_lossy() != ":memory:" {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .execute(&db)
        .await?;
    sqlx::migrate!("../../migrations").run(&db).await?;
    security::sync_admin(&db, &runtime.config.password).await?;
    let reset_password = runtime.reset_password.clone();
    let app = App {
        admin: Arc::new(admin::Admin::new(runtime)),
        db,
        secure: origin
            .as_deref()
            .is_some_and(|value| value.starts_with("https://")),
        origin,
        devices: Default::default(),
        rates: Default::default(),
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?,
    };
    if let Some((username, password)) = reset_password {
        api::reset_password_local(&app, &username, &password)
            .await
            .map_err(|e| anyhow::anyhow!("Password reset failed: {}", e.1))?;
        println!("Password reset: {username}");
        return Ok(());
    }
    tokio::spawn(api::cleanup_worker(app.clone()));
    let routes = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(api::ready))
        .route("/api/v1/diagnostics", get(api::diagnostics))
        .route("/api/v1/admin/dashboard", get(admin::dashboard))
        .route("/api/v1/admin/logs", get(admin::logs))
        .route("/api/v1/admin/version", get(admin::version))
        .route(
            "/api/v1/admin/upgrade",
            get(admin::status).post(admin::upgrade),
        )
        .route("/api/v1/admin/restart", post(admin::restart))
        .route("/api/v1/auth/register", post(api::register))
        .route("/api/v1/auth/password/login", post(api::password_login))
        .route("/api/v1/auth/logout", post(api::logout))
        .route("/api/v1/me", get(api::me))
        .route("/api/v1/me/password", put(api::change_password))
        .route(
            "/api/v1/me/sessions",
            get(api::sessions).delete(api::logout_all),
        )
        .route(
            "/api/v1/me/preferences",
            get(api::preferences).put(api::save_preferences),
        )
        .route("/api/v1/instances", get(api::instances))
        .route(
            "/api/v1/instances/:id/grants",
            get(api::grants).put(api::set_grant),
        )
        .route(
            "/api/v1/instances/:id/grants/:username",
            delete(api::remove_grant),
        )
        .route("/api/v1/instances/:id/binding", delete(api::unbind))
        .route(
            "/api/v1/instances/:id/credentials/rotate",
            post(api::rotate),
        )
        .route("/api/v1/instances/:id/terminal-tickets", post(api::ticket))
        .route(
            "/api/v1/terminal-connections/:id/ws",
            get(gateway::browser_upgrade),
        )
        .route("/api/v1/events", get(api::events))
        .route("/api/v1/instances/register", post(api::register_instance))
        .route("/connector/v1/connect", get(gateway::device_upgrade))
        .route("/connector/v1/name", post(api::rename_device))
        .layer(middleware::from_fn_with_state(app.clone(), security::guard))
        .with_state(app.clone());
    let routes = if let Ok(assets) = std::env::var("HUB_ASSETS") {
        routes.fallback_service(
            ServeDir::new(&assets)
                .not_found_service(ServeFile::new(format!("{assets}/index.html"))),
        )
    } else {
        routes.fallback(assets::embedded)
    };
    let secure = app.secure;
    let routes=routes.layer(axum::middleware::from_fn(move|request:axum::extract::Request,next:axum::middleware::Next|async move{
      let mut response=next.run(request).await;
      let headers=response.headers_mut();
      headers.insert("content-security-policy","default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'".parse().unwrap());
      headers.insert("x-content-type-options","nosniff".parse().unwrap());
      headers.insert("referrer-policy","no-referrer".parse().unwrap());
      headers.insert("permissions-policy","microphone=(self)".parse().unwrap());
      if secure{headers.insert("strict-transport-security","max-age=31536000".parse().unwrap());}
      response
    }));
    let listener = tokio::net::TcpListener::bind(
        std::env::var("HUB_LISTEN").unwrap_or_else(|_| "0.0.0.0:8088".into()),
    )
    .await?;
    tracing::info!(address=%listener.local_addr()?,"Hub listening");
    let restarting = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = restarting.clone();
    let admin = app.admin.clone();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        #[cfg(unix)]
        let terminated = async {
            terminate.recv().await;
        };
        #[cfg(not(unix))]
        let terminated = std::future::pending::<()>();
        tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = terminated=>{},_ = admin.restart.notified()=>{flag.store(true,std::sync::atomic::Ordering::SeqCst);}}
        let _ = stop_tx.send(());
    });
    let server = axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = stop_rx.await;
    });
    let admin = app.admin.clone();
    let shutdown = async {
        while !restarting.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    };
    tokio::select! {result=server=>{result?;},_ = shutdown=>{}}
    if restarting.load(std::sync::atomic::Ordering::SeqCst) {
        app.db.close().await;
        tracing::info!("Restarting Hub");
        drop(_log_guard);
        return admin::exec_restart(&app.admin.executable, &app.admin.runtime.config.password);
    }
    let _ = admin;
    Ok(())
}
