// Stage 3a: engine sidecar manager. The shell owns the engine process lifecycle
// (spawn / restart / kill) and port selection. No musical logic here — ever.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use tauri::{Manager, State};

const ENGINE_EXE: &str = "scorch-engine";
const BASE_PORT: u16 = 9377;
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW_SECS: u64 = 60;

pub struct EngineState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
    restart_count: Mutex<u32>,
    first_restart_at: Mutex<Option<Instant>>,
    failed: Mutex<bool>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(0),
            restart_count: Mutex::new(0),
            first_restart_at: Mutex::new(None),
            failed: Mutex::new(false),
        }
    }
}

/// Resolve the engine exe path. In prod (bundled), it's next to scorch.exe via
/// tauri.conf.json's bundle.resources mapping. In dev, look in engine/build/.
/// Returns None if not found (frontend shows "engine: off"; app still boots).
fn engine_exe_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Prod: next to scorch.exe (bundle.resources places it there).
    let candidate = dir.join(format!("{ENGINE_EXE}.exe"));
    if candidate.exists() {
        return Some(candidate);
    }
    // Dev fallback: engine/build/Release/scorch-engine.exe (CMake output).
    // Walk up from the exe to find the repo root, then engine/build/.
    let mut ancestor = Some(dir);
    while let Some(d) = ancestor {
        let dev_candidate = d.join("engine").join("build").join("Release").join(format!("{ENGINE_EXE}.exe"));
        if dev_candidate.exists() {
            return Some(dev_candidate);
        }
        ancestor = d.parent();
    }
    None
}

/// Find a free port: try BASE_PORT, BASE_PORT+1, ... up to +20, then give up.
fn find_port() -> Option<u16> {
    for offset in 0..20u16 {
        let port = BASE_PORT + offset;
        // Try to bind — if it fails, port is in use.
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Spawn the engine process with the given port. Returns the Child handle.
fn spawn_engine(port: u16) -> Option<Child> {
    let exe = engine_exe_path()?;
    Command::new(exe)
        .args(["--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// Start the engine. Called once at app launch from setup().
pub fn start_engine(state: &EngineState) -> u16 {
    let port = find_port().unwrap_or(BASE_PORT);
    *state.port.lock().unwrap() = port;
    if let Some(child) = spawn_engine(port) {
        *state.child.lock().unwrap() = Some(child);
        eprintln!("[shell] engine started on port {port}");
    } else {
        eprintln!("[shell] engine exe not found — running without engine");
        *state.failed.lock().unwrap() = true;
    }
    port
}

/// Check if the engine is alive; if it died and we haven't exhausted restarts,
/// respawn. Called periodically from a background thread.
pub fn check_and_restart(state: &EngineState) {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        match child.try_wait() {
            Ok(Some(_)) => {
                // Process exited — try to restart.
                drop(child_guard);
                let mut count = state.restart_count.lock().unwrap();
                let mut first_at = state.first_restart_at.lock().unwrap();
                if *count == 0 {
                    *first_at = Some(Instant::now());
                }
                if let Some(start) = *first_at {
                    if start.elapsed().as_secs() > RESTART_WINDOW_SECS {
                        // Window reset — allow fresh restarts.
                        *count = 0;
                        *first_at = Some(Instant::now());
                    }
                }
                if *count >= MAX_RESTARTS {
                    *state.failed.lock().unwrap() = true;
                    eprintln!("[shell] engine failed — max restarts exceeded");
                    return;
                }
                *count += 1;
                let port = *state.port.lock().unwrap();
                eprintln!("[shell] engine died — restarting ({}/{})", *count, MAX_RESTARTS);
                if let Some(new_child) = spawn_engine(port) {
                    *state.child.lock().unwrap() = Some(new_child);
                } else {
                    *state.failed.lock().unwrap() = true;
                }
            }
            Ok(None) => { /* still running */ }
            Err(_) => { /* error checking — treat as dead, try restart */ }
        }
    }
}

/// Kill the engine on app close. No orphans.
pub fn kill_engine(state: &EngineState) {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[shell] engine killed on app close");
    }
}

/// Tauri command: frontend calls this to get the engine port.
#[tauri::command]
pub fn get_engine_info(state: State<'_, EngineState>) -> serde_json::Value {
    let port = *state.port.lock().unwrap();
    let failed = *state.failed.lock().unwrap();
    serde_json::json!({
        "port": port,
        "failed": failed,
    })
}
