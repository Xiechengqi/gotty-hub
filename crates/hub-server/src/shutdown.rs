//! One shutdown path for signals, administrator restarts and upgrades.
use std::{
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub const DRAIN_LIMIT: Duration = Duration::from_secs(3);
pub const TOTAL_LIMIT: Duration = Duration::from_secs(5);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Running,
    Restart,
    Exit,
    Forced,
}
#[derive(Clone)]
pub struct Shutdown(Arc<Inner>);
struct Inner {
    phase: watch::Sender<Phase>,
    stop: CancellationToken,
    started: OnceLock<Instant>,
    watchdog: Mutex<Option<mpsc::Sender<Deadline>>>,
    tasks: TaskTracker,
}
enum Deadline {
    Start(Instant),
    Force,
    Finished,
}

impl Shutdown {
    pub fn new() -> Self {
        let (phase, _) = watch::channel(Phase::Running);
        Self(Arc::new(Inner {
            phase,
            stop: CancellationToken::new(),
            started: OnceLock::new(),
            watchdog: Mutex::new(None),
            tasks: TaskTracker::new(),
        }))
    }
    pub fn phase(&self) -> Phase {
        *self.0.phase.borrow()
    }
    pub fn is_stopping(&self) -> bool {
        self.phase() != Phase::Running
    }
    pub async fn cancelled(&self) {
        self.0.stop.cancelled().await;
    }
    pub fn tasks(&self) -> &TaskTracker {
        &self.0.tasks
    }
    fn notify_deadline(&self, event: Deadline) {
        if let Some(sender) = self.0.watchdog.lock().unwrap().as_ref() {
            let _ = sender.send(event);
        }
    }
    fn start(&self) {
        self.0.started.get_or_init(|| {
            let started = Instant::now();
            self.notify_deadline(Deadline::Start(started));
            started
        });
        self.0.stop.cancel();
    }
    pub fn restart(&self) {
        if self.0.phase.send_if_modified(|phase| {
            if *phase == Phase::Running {
                *phase = Phase::Restart;
                true
            } else {
                false
            }
        }) {
            self.start();
            tracing::info!("Hub restart requested");
        }
    }
    pub fn exit(&self) {
        self.0.phase.send_modify(|phase| {
            *phase = match phase {
                Phase::Running | Phase::Restart => Phase::Exit,
                Phase::Exit | Phase::Forced => Phase::Forced,
            };
        });
        self.start();
        if self.phase() == Phase::Forced {
            self.notify_deadline(Deadline::Force);
        }
    }
    pub fn remaining(&self, limit: Duration) -> Duration {
        self.0
            .started
            .get()
            .map(|started| limit.saturating_sub(started.elapsed()))
            .unwrap_or(limit)
    }
    pub fn close_code(&self) -> u16 {
        if self.phase() == Phase::Restart {
            1012
        } else {
            1001
        }
    }
    pub async fn until_stopped<F: std::future::Future>(&self, future: F) -> Option<F::Output> {
        tokio::select! { biased; _ = self.cancelled() => None, result = future => Some(result) }
    }
    /// A process-level bound also covers runtime teardown, blocking tasks and log flushing.
    /// Unit tests never install this guard; real signal/process checks run in CI.
    pub fn install_deadline(&self) -> DeadlineGuard {
        let (sender, receiver) = mpsc::channel();
        *self.0.watchdog.lock().unwrap() = Some(sender.clone());
        std::thread::spawn(move || {
            let started = match receiver.recv() {
                Ok(Deadline::Start(started)) => started,
                Ok(Deadline::Force) => std::process::exit(130),
                _ => return,
            };
            match receiver.recv_timeout(TOTAL_LIMIT.saturating_sub(started.elapsed())) {
                Ok(Deadline::Finished) | Err(mpsc::RecvTimeoutError::Disconnected) => (),
                // Do not write to stdout/stderr here: a full pipe must not
                // prevent the independent process deadline from taking effect.
                Ok(Deadline::Force) => std::process::exit(130),
                _ => std::process::exit(124),
            }
        });
        DeadlineGuard(sender)
    }
}
pub struct DeadlineGuard(mpsc::Sender<Deadline>);
impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        let _ = self.0.send(Deadline::Finished);
    }
}

pub fn listen(shutdown: Shutdown) -> std::io::Result<tokio::task::JoinHandle<()>> {
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    Ok(tokio::spawn(async move {
        loop {
            #[cfg(unix)]
            let signal = async {
                tokio::select! { biased; _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
            };
            #[cfg(not(unix))]
            let signal = async {
                let _ = tokio::signal::ctrl_c().await;
            };
            signal.await;
            shutdown.exit();
            tracing::info!(phase=?shutdown.phase(), "Shutdown signal received");
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn signals_override_restart_and_a_second_signal_forces_exit() {
        let shutdown = Shutdown::new();
        let waiter = shutdown.clone();
        let task = tokio::spawn(async move {
            waiter.cancelled().await;
        });
        shutdown.restart();
        assert_eq!(shutdown.phase(), Phase::Restart);
        assert_eq!(shutdown.close_code(), 1012);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        shutdown.exit();
        shutdown.restart();
        assert_eq!(shutdown.phase(), Phase::Exit);
        assert_eq!(shutdown.close_code(), 1001);
        shutdown.exit();
        assert_eq!(shutdown.phase(), Phase::Forced);
    }
    #[tokio::test]
    async fn tracked_tasks_and_pending_operations_finish_on_shutdown() {
        let shutdown = Shutdown::new();
        let worker = shutdown.clone();
        shutdown.tasks().spawn(async move {
            assert!(worker
                .until_stopped(std::future::pending::<()>())
                .await
                .is_none());
        });
        shutdown.exit();
        shutdown.tasks().close();
        tokio::time::timeout(Duration::from_secs(1), shutdown.tasks().wait())
            .await
            .unwrap();
        assert!(shutdown.remaining(TOTAL_LIMIT) <= TOTAL_LIMIT);
        assert_eq!(shutdown.remaining(Duration::ZERO), Duration::ZERO);
    }
}
