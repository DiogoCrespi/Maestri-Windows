//! Testable Routine Runtime engine for Windows.

use crate::routines::{Routine, RoutineManager};
use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MIN_TICK_INTERVAL_MS: u64 = 100;

pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

pub struct MockClock {
    current: AtomicU64,
}

impl MockClock {
    pub fn new(initial_ms: u64) -> Self {
        Self {
            current: AtomicU64::new(initial_ms),
        }
    }

    pub fn set(&self, ms: u64) {
        self.current.store(ms, Ordering::SeqCst);
    }

    pub fn advance(&self, ms: u64) {
        self.current.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for MockClock {
    fn now_ms(&self) -> u64 {
        self.current.load(Ordering::SeqCst)
    }
}

pub type DispatchCallback =
    Arc<dyn Fn(&Routine, &str) -> Result<(), String> + Send + Sync + 'static>;

struct InFlightGuard {
    id: String,
    set: Arc<Mutex<HashSet<String>>>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut lock) = self.set.lock() {
            lock.remove(&self.id);
        }
    }
}

pub struct RoutineRuntime {
    manager: Arc<RwLock<RoutineManager>>,
    clock: Arc<dyn Clock>,
    persist_path: Arc<RwLock<Option<PathBuf>>>,
    workspace_root: Arc<RwLock<Option<PathBuf>>>,
    in_flight: Arc<Mutex<HashSet<String>>>,
    dispatch_cb: Arc<RwLock<Option<DispatchCallback>>>,
    is_running: Arc<AtomicBool>,
    shutdown_cv: Arc<(Mutex<bool>, Condvar)>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
}

impl RoutineRuntime {
    pub fn new(clock: Arc<dyn Clock>, initial_workspace_path: Option<PathBuf>) -> Self {
        let base_dir = initial_workspace_path.map(|p| {
            if p.is_file() || p.file_name().and_then(|n| n.to_str()) == Some("workspace.json") {
                p.parent().unwrap_or(&p).to_path_buf()
            } else {
                p
            }
        });

        let persist_path = base_dir
            .as_ref()
            .map(|b| b.join(".maestri").join("routines.json"));
        let manager = Arc::new(RwLock::new(RoutineManager::new()));
        if let Some(path) = &persist_path {
            if let Ok(mut mgr) = manager.write() {
                let _ = mgr.load_from_file(path);
            }
        }

        Self {
            manager,
            clock,
            persist_path: Arc::new(RwLock::new(persist_path)),
            workspace_root: Arc::new(RwLock::new(base_dir)),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            dispatch_cb: Arc::new(RwLock::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
            shutdown_cv: Arc::new((Mutex::new(false), Condvar::new())),
            worker_handle: Mutex::new(None),
        }
    }

    /// Transactionally switches current workspace path, saving previous and loading new routines.json.
    /// Handles workspace.json file path input by deriving its parent directory.
    pub fn set_workspace(&self, workspace_path: Option<&Path>) -> Result<usize, String> {
        let mut mgr = self
            .manager
            .write()
            .map_err(|_| "Manager lock poisoned".to_string())?;
        let mut path_guard = self
            .persist_path
            .write()
            .map_err(|_| "Path lock poisoned".to_string())?;
        let mut root_guard = self
            .workspace_root
            .write()
            .map_err(|_| "Workspace root lock poisoned".to_string())?;

        // 1. Save current routines if path exists, propagating error
        if let Some(current_path) = path_guard.as_ref() {
            mgr.save_to_file(current_path)?;
        }

        // 2. Derive base directory (if workspace.json was passed, use parent directory)
        let base_dir = workspace_path.map(|p| {
            if p.is_file() || p.file_name().and_then(|n| n.to_str()) == Some("workspace.json") {
                p.parent().unwrap_or(p).to_path_buf()
            } else {
                p.to_path_buf()
            }
        });

        let new_routines_path = base_dir
            .as_ref()
            .map(|b| b.join(".maestri").join("routines.json"));

        // 3. Load routines from new path
        let count = if let Some(path) = &new_routines_path {
            mgr.load_from_file(path)?
        } else {
            mgr.load_from_file(Path::new(""))? // Clears routines
        };

        *path_guard = new_routines_path;
        *root_guard = base_dir;
        Ok(count)
    }

    pub fn workspace_root(&self) -> Result<PathBuf, String> {
        let guard = self
            .workspace_root
            .read()
            .map_err(|_| "Workspace root lock poisoned".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "error: no active workspace set".to_string())
    }

    pub fn set_dispatch_callback<F>(&self, callback: F)
    where
        F: Fn(&Routine, &str) -> Result<(), String> + Send + Sync + 'static,
    {
        if let Ok(mut cb_guard) = self.dispatch_cb.write() {
            *cb_guard = Some(Arc::new(callback));
        }
    }

    pub fn upsert_routine(&self, routine: Routine) -> Result<(), String> {
        let mut mgr = self
            .manager
            .write()
            .map_err(|_| "Manager lock poisoned".to_string())?;
        mgr.upsert(routine)?;
        if let Ok(path_guard) = self.persist_path.read() {
            if let Some(path) = path_guard.as_ref() {
                mgr.save_to_file(path)?;
            }
        }
        Ok(())
    }

    pub fn remove_routine(&self, id: &str) -> Result<bool, String> {
        let mut mgr = self
            .manager
            .write()
            .map_err(|_| "Manager lock poisoned".to_string())?;
        let removed = mgr.remove(id);
        if removed {
            if let Ok(path_guard) = self.persist_path.read() {
                if let Some(path) = path_guard.as_ref() {
                    mgr.save_to_file(path)?;
                }
            }
        }
        Ok(removed)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<bool, String> {
        let mut mgr = self
            .manager
            .write()
            .map_err(|_| "Manager lock poisoned".to_string())?;
        if let Some(routine) = mgr.get(id).cloned() {
            let mut updated = routine;
            updated.enabled = enabled;
            mgr.upsert(updated)?;
            if let Ok(path_guard) = self.persist_path.read() {
                if let Some(path) = path_guard.as_ref() {
                    mgr.save_to_file(path)?;
                }
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn get_routine(&self, id: &str) -> Option<Routine> {
        self.manager.read().ok()?.get(id).cloned()
    }

    pub fn list_routines(&self) -> Vec<Routine> {
        self.manager
            .read()
            .ok()
            .map(|mgr| mgr.list().into_iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn tick(&self) -> usize {
        let now_ms = self.clock.now_ms();
        let due_ids = {
            let mgr = match self.manager.read() {
                Ok(m) => m,
                Err(_) => return 0,
            };
            mgr.find_due(now_ms)
        };

        let mut dispatched_count = 0;
        for id in due_ids {
            if self.execute_routine_id(&id, now_ms, false) {
                dispatched_count += 1;
            }
        }
        dispatched_count
    }

    pub fn execute_routine_id(&self, id: &str, now_ms: u64, ignore_policy: bool) -> bool {
        {
            let mut flight = match self.in_flight.lock() {
                Ok(g) => g,
                Err(_) => return false,
            };
            if flight.contains(id) {
                return false;
            }
            flight.insert(id.to_string());
        }

        let _guard = InFlightGuard {
            id: id.to_string(),
            set: Arc::clone(&self.in_flight),
        };

        let routine = match self.get_routine(id) {
            Some(r) => r,
            None => return false,
        };

        if !ignore_policy {
            if !routine.enabled || !routine.is_due(now_ms) {
                return false;
            }
        }

        let cb_opt = match self.dispatch_cb.read() {
            Ok(g) => g.clone(),
            Err(_) => None,
        };

        let cb = match cb_opt {
            Some(cb) => cb,
            None => return false,
        };

        let idempotency_key = format!("{}:{}:{}", routine.id, routine.execution_count + 1, now_ms);

        let panic_res = catch_unwind(AssertUnwindSafe(|| cb(&routine, &idempotency_key)));
        match panic_res {
            Ok(Ok(())) => {
                if let Ok(mut mgr) = self.manager.write() {
                    if let Some(r) = mgr.get(id).cloned() {
                        let mut updated = r;
                        updated.record_execution(now_ms, idempotency_key);
                        let _ = mgr.upsert(updated);
                        if let Ok(path_guard) = self.persist_path.read() {
                            if let Some(path) = path_guard.as_ref() {
                                let _ = mgr.save_to_file(path);
                            }
                        }
                    }
                }
                true
            }
            _ => false,
        }
    }

    pub fn start(&self, tick_interval_ms: u64) -> Result<(), String> {
        let interval = tick_interval_ms.max(MIN_TICK_INTERVAL_MS);

        if self.is_running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let is_running = Arc::clone(&self.is_running);
        let manager_arc = Arc::clone(&self.manager);
        let clock_arc = Arc::clone(&self.clock);
        let in_flight_arc = Arc::clone(&self.in_flight);
        let dispatch_cb_arc = Arc::clone(&self.dispatch_cb);
        let shutdown_cv_arc = Arc::clone(&self.shutdown_cv);
        let persist_path_arc = Arc::clone(&self.persist_path);

        {
            let mut lock = shutdown_cv_arc.0.lock().unwrap();
            *lock = false;
        }

        let handle = thread::Builder::new()
            .name("routine-scheduler-worker".to_string())
            .spawn(move || {
                while is_running.load(Ordering::SeqCst) {
                    let now_ms = clock_arc.now_ms();
                    let due_ids = {
                        if let Ok(mgr) = manager_arc.read() {
                            mgr.find_due(now_ms)
                        } else {
                            Vec::new()
                        }
                    };

                    for id in due_ids {
                        if !is_running.load(Ordering::SeqCst) {
                            break;
                        }

                        let flight_ok = {
                            if let Ok(mut flight) = in_flight_arc.lock() {
                                if flight.contains(&id) {
                                    false
                                } else {
                                    flight.insert(id.clone());
                                    true
                                }
                            } else {
                                false
                            }
                        };

                        if !flight_ok {
                            continue;
                        }

                        let _guard = InFlightGuard {
                            id: id.clone(),
                            set: Arc::clone(&in_flight_arc),
                        };

                        let routine_opt = if let Ok(mgr) = manager_arc.read() {
                            mgr.get(&id).cloned()
                        } else {
                            None
                        };

                        if let Some(routine) = routine_opt {
                            let cb_opt = match dispatch_cb_arc.read() {
                                Ok(g) => g.clone(),
                                Err(_) => None,
                            };

                            if let Some(cb) = cb_opt {
                                let idempotency_key = format!(
                                    "{}:{}:{}",
                                    routine.id,
                                    routine.execution_count + 1,
                                    now_ms
                                );
                                let panic_res = catch_unwind(AssertUnwindSafe(|| {
                                    cb(&routine, &idempotency_key)
                                }));
                                if matches!(panic_res, Ok(Ok(()))) {
                                    if let Ok(mut mgr) = manager_arc.write() {
                                        if let Some(r) = mgr.get(&id).cloned() {
                                            let mut updated = r;
                                            updated.record_execution(now_ms, idempotency_key);
                                            let _ = mgr.upsert(updated);
                                            if let Ok(path_guard) = persist_path_arc.read() {
                                                if let Some(p) = path_guard.as_ref() {
                                                    let _ = mgr.save_to_file(p);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let (lock, cvar) = &*shutdown_cv_arc;
                    let mut guard = lock.lock().unwrap();
                    if !*guard {
                        let _ = cvar.wait_timeout(guard, Duration::from_millis(interval));
                    }
                }
            });

        match handle {
            Ok(h) => {
                if let Ok(mut worker_guard) = self.worker_handle.lock() {
                    *worker_guard = Some(h);
                }
                Ok(())
            }
            Err(e) => {
                self.is_running.store(false, Ordering::SeqCst);
                Err(format!("Failed to spawn worker thread: {e}"))
            }
        }
    }

    pub fn shutdown(&self) {
        if self.is_running.swap(false, Ordering::SeqCst) {
            {
                let (lock, cvar) = &*self.shutdown_cv;
                if let Ok(mut guard) = lock.lock() {
                    *guard = true;
                    cvar.notify_all();
                }
            }
            let handle = if let Ok(mut worker_guard) = self.worker_handle.lock() {
                worker_guard.take()
            } else {
                None
            };
            if let Some(h) = handle {
                let _ = h.join();
            }
        }
    }
}

impl Drop for RoutineRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routines::{ExecutionLimit, RoutineAction, SchedulePattern};
    use std::fs;
    use std::sync::atomic::AtomicUsize;

    fn sample_routine(id: &str) -> Routine {
        Routine {
            id: id.to_string(),
            name: "Test Routine".to_string(),
            target_terminal_id: "term-1".to_string(),
            action: RoutineAction::Command {
                command: "dir".to_string(),
            },
            schedule: SchedulePattern::Every {
                interval_seconds: 10,
            },
            limit: ExecutionLimit::Indefinite,
            enabled: true,
            pre_run_script: None,
            no_notify: false,
            execution_count: 0,
            first_run_at: None,
            last_run_at: None,
            created_at: 1000000,
            last_idempotency_key: None,
        }
    }

    #[test]
    fn workspace_path_resolution_and_json_parent() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        let temp_dir = std::env::temp_dir().join("maestri_ws_test");
        let ws_json = temp_dir.join("workspace.json");
        fs::create_dir_all(temp_dir.join(".maestri")).unwrap();

        // 1. Pass workspace.json path -> derives parent folder .maestri/routines.json
        assert_eq!(runtime.set_workspace(Some(&ws_json)).unwrap(), 0);
        assert_eq!(runtime.workspace_root().unwrap(), temp_dir);

        let mut r = sample_routine("r1");
        runtime.upsert_routine(r.clone()).unwrap();

        let target_file = temp_dir.join(".maestri").join("routines.json");
        assert!(target_file.exists());

        // 2. Switch workspace to None -> saves old, clears current
        assert_eq!(runtime.set_workspace(None).unwrap(), 0);
        assert!(runtime.get_routine("r1").is_none());
        assert!(runtime.workspace_root().is_err());

        // 3. Switch back to workspace.json -> loads 1 routine
        assert_eq!(runtime.set_workspace(Some(&ws_json)).unwrap(), 1);
        assert!(runtime.get_routine("r1").is_some());
        assert_eq!(runtime.workspace_root().unwrap(), temp_dir);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn panic_in_callback_is_caught_and_releases_inflight() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        runtime.set_dispatch_callback(|_r, _k| {
            panic!("Boom in callback!");
        });

        runtime.upsert_routine(sample_routine("r1")).unwrap();
        assert!(!runtime.execute_routine_id("r1", 1000000, true));
        assert!(!runtime.in_flight.lock().unwrap().contains("r1"));
    }

    #[test]
    fn mock_clock_advancement_and_tick() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock.clone(), None);

        let counter = Arc::new(AtomicUsize::new(0));
        let c_clone = counter.clone();
        runtime.set_dispatch_callback(move |_r, _k| {
            c_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        runtime.upsert_routine(sample_routine("r1")).unwrap();

        assert_eq!(runtime.tick(), 1);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        let r = runtime.get_routine("r1").unwrap();
        assert_eq!(r.execution_count, 1);
        assert_eq!(r.last_run_at, Some(1000000));

        clock.set(1005000);
        assert_eq!(runtime.tick(), 0);

        clock.set(1011000);
        assert_eq!(runtime.tick(), 1);
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn dispatch_failure_or_missing_callback_does_not_record_execution() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        runtime.upsert_routine(sample_routine("r1")).unwrap();

        assert_eq!(runtime.tick(), 0);
        let r = runtime.get_routine("r1").unwrap();
        assert_eq!(r.execution_count, 0);

        runtime.set_dispatch_callback(|_r, _k| Err("Failed dispatch".to_string()));
        assert_eq!(runtime.tick(), 0);
        let r2 = runtime.get_routine("r1").unwrap();
        assert_eq!(r2.execution_count, 0);
    }

    #[test]
    fn dynamic_callback_update_after_start() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        runtime.upsert_routine(sample_routine("r1")).unwrap();
        assert_eq!(runtime.tick(), 0);

        let counter = Arc::new(AtomicUsize::new(0));
        let c_clone = counter.clone();
        runtime.set_dispatch_callback(move |_r, _k| {
            c_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        assert_eq!(runtime.tick(), 1);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn manual_execution_policy_validation() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        let counter = Arc::new(AtomicUsize::new(0));
        let c_clone = counter.clone();
        runtime.set_dispatch_callback(move |_r, _k| {
            c_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        let mut r = sample_routine("r1");
        r.enabled = false;
        runtime.upsert_routine(r).unwrap();

        assert!(!runtime.execute_routine_id("r1", 1000000, false));
        assert_eq!(counter.load(Ordering::SeqCst), 0);

        assert!(runtime.execute_routine_id("r1", 1000000, true));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn interruptible_worker_shutdown() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);
        runtime.start(5000).unwrap();
        assert!(runtime.is_running.load(Ordering::SeqCst));

        let start_time = SystemTime::now();
        runtime.shutdown();
        assert!(start_time.elapsed().unwrap() < Duration::from_secs(2));
        assert!(!runtime.is_running.load(Ordering::SeqCst));
    }

    #[test]
    fn notes_access_fail_closed_without_workspace_and_scoped_access() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        // 1. Fail-closed check: No workspace set
        assert!(runtime.workspace_root().is_err());

        // 2. Set workspace -> scoped notes directory valid
        let temp_dir = std::env::temp_dir().join("maestri_notes_test");
        let notes_dir = temp_dir.join("notes");
        fs::create_dir_all(&notes_dir).unwrap();

        runtime.set_workspace(Some(&temp_dir)).unwrap();
        let ws_root = runtime.workspace_root().unwrap();
        let root_str = ws_root.to_string_lossy();

        // Write note inside notes directory
        assert!(crate::notes::note_save_scoped(&root_str, "test.md", "hello world").is_ok());
        assert_eq!(
            crate::notes::note_read_scoped(&root_str, "test.md").unwrap(),
            "hello world"
        );

        // Attempt external path escape -> rejected
        assert!(crate::notes::note_read_scoped(&root_str, "../outside.md").is_err());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pre_run_script_and_no_notify_semantics() {
        let clock = Arc::new(MockClock::new(1000000));
        let runtime = RoutineRuntime::new(clock, None);

        let received_payloads = Arc::new(Mutex::new(Vec::new()));
        let recv_clone = received_payloads.clone();

        runtime.set_dispatch_callback(move |routine, _key| {
            let payload = match &routine.action {
                RoutineAction::Command { command } => match &routine.pre_run_script {
                    Some(script) if !script.trim().is_empty() => {
                        format!("{script}\r\n{command}\r\n")
                    }
                    _ => format!("{command}\r\n"),
                },
                RoutineAction::Reminder { reminder } => reminder.clone(),
            };
            recv_clone
                .lock()
                .unwrap()
                .push((routine.id.clone(), payload, routine.no_notify));
            Ok(())
        });

        // 1. Command routine with preRunScript
        let mut r1 = sample_routine("r1");
        r1.pre_run_script = Some("cd C:\\repo".to_string());
        r1.action = RoutineAction::Command {
            command: "git status".to_string(),
        };
        runtime.upsert_routine(r1).unwrap();

        // 2. Reminder routine with noNotify = true
        let mut r2 = sample_routine("r2");
        r2.no_notify = true;
        r2.action = RoutineAction::Reminder {
            reminder: "Do backup".to_string(),
        };
        runtime.upsert_routine(r2).unwrap();

        assert_eq!(runtime.tick(), 2);

        let logs = received_payloads.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert!(logs.contains(&(
            "r1".to_string(),
            "cd C:\\repo\r\ngit status\r\n".to_string(),
            false
        )));
        assert!(logs.contains(&("r2".to_string(), "Do backup".to_string(), true)));

        // Execution counts incremented after successful dispatch callback
        assert_eq!(runtime.get_routine("r1").unwrap().execution_count, 1);
        assert_eq!(runtime.get_routine("r2").unwrap().execution_count, 1);
    }
}
