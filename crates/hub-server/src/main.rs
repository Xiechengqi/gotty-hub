mod admin;
mod api;
mod assets;
mod config;
mod gateway;
mod origin;
mod security;
mod shutdown;
mod terminal_settings;
use axum::{
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use sqlx::sqlite::SqlitePoolOptions;
use std::{collections::HashMap, future::IntoFuture, sync::Arc, time::Duration};
use tokio::sync::Mutex;
#[derive(Clone)]
pub struct App {
    pub admin: Arc<admin::Admin>,
    pub db: sqlx::SqlitePool,
    pub addresses: origin::Policy,
    pub assets: Arc<assets::Store>,
    pub shutdown: shutdown::Shutdown,
    pub devices: Arc<Mutex<HashMap<String, gateway::Device>>>,
    pub rates: Arc<Mutex<HashMap<String, (u64, u32)>>>,
    pub http: reqwest::Client,
}
fn main() -> anyhow::Result<()> {
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
    let (writer, log_guard) = tracing_appender::non_blocking(log);
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
    let shutdown = shutdown::Shutdown::new();
    let deadline = shutdown.install_deadline();
    let executor = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = executor.block_on(async {
        let _signals = shutdown::listen(shutdown.clone())?;
        serve(runtime, shutdown.clone()).await
    });
    if shutdown.is_stopping() {
        tracing::info!(phase=?shutdown.phase(), "Hub cleanup complete");
    }
    // Keep the signal task alive while flushing logs. The process watchdog also
    // bounds this destructor and runtime shutdown, including blocking workers.
    drop(log_guard);
    executor.shutdown_timeout(
        shutdown
            .remaining(shutdown::TOTAL_LIMIT)
            .min(Duration::from_millis(250)),
    );
    let restarting = shutdown.phase() == shutdown::Phase::Restart;
    drop(deadline);
    if let Some((executable, password)) = result? {
        if restarting {
            return admin::exec_restart(&executable, &password);
        }
    }
    Ok(())
}

async fn serve(
    runtime: config::Runtime,
    shutdown: shutdown::Shutdown,
) -> anyhow::Result<Option<(std::path::PathBuf, String)>> {
    let addresses = origin::Policy::new(&runtime.config)?;
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
    let assets = Arc::new(assets::Store::load(
        &runtime.home,
        std::env::var_os("HUB_ASSETS")
            .as_deref()
            .map(std::path::Path::new),
    )?);
    let app = App {
        admin: Arc::new(admin::Admin::new(runtime)),
        db,
        addresses,
        assets,
        shutdown: shutdown.clone(),
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
        return Ok(None);
    }
    shutdown.tasks().spawn(api::cleanup_worker(app.clone()));
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
            "/api/v1/me/terminal-settings",
            get(terminal_settings::get).put(terminal_settings::save),
        )
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
        .fallback(assets::serve)
        .with_state(app.clone())
        .layer(middleware::from_fn_with_state(app.clone(), origin::headers))
        .layer(middleware::from_fn_with_state(app.clone(), assets::observe));
    let listener = tokio::net::TcpListener::bind(
        std::env::var("HUB_LISTEN").unwrap_or_else(|_| "0.0.0.0:8088".into()),
    )
    .await?;
    tracing::info!(address=%listener.local_addr()?, revision=env!("HUB_REVISION"), assets=%app.assets.generation, "Hub listening");
    let stop = shutdown.clone();
    let server = axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        stop.cancelled().await;
    });
    let mut server = Box::pin(server.into_future());
    let mut failure = None;
    let completed = tokio::select! {
        result = &mut server => { failure = result.err(); if !shutdown.is_stopping() { shutdown.exit(); } true }
        _ = shutdown.cancelled() => false,
    };
    shutdown.tasks().close();
    let drain = async {
        if !completed {
            failure = server.await.err();
        }
        shutdown.tasks().wait().await;
    };
    if tokio::time::timeout(shutdown.remaining(shutdown::DRAIN_LIMIT), drain)
        .await
        .is_err()
    {
        tracing::warn!("Connection drain exceeded 3 seconds; remaining tasks will be cancelled");
    }
    // Reserve time for the bounded logger flush and runtime teardown as well.
    let cleanup_budget = shutdown
        .remaining(shutdown::TOTAL_LIMIT)
        .saturating_sub(Duration::from_millis(1500));
    let cleanup = async {
        app.devices.lock().await.clear();
        app.db.close().await;
    };
    if tokio::time::timeout(cleanup_budget, cleanup).await.is_err() {
        tracing::warn!("Database cleanup reached its shutdown deadline");
    }
    if let Some(error) = failure {
        return Err(error.into());
    }
    Ok(Some((
        app.admin.executable.clone(),
        app.admin.runtime.config.password.clone(),
    )))
}
