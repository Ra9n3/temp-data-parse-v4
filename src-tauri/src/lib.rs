// Scorch desktop shell — thin window + webview.
// Stage 2: scorch:// protocol serves from <exe-dir>/web/<version>/ (hot-swap
// tier) with path-traversal protection, minShell handshake, and graceful
// fallback to the bundled dist/ embedded in the binary.
// Stage 3a: spawns scorch-engine as a sidecar, manages its lifecycle (restart
// on crash, kill on app close), and exposes get_engine_info to the frontend.
// Stage 3b polish: error.log rider (frontend diagnostics →
// %APPDATA%/scorch/error.log, 1 MB rotate) and a release-devtools command
// (F12 binding lives in the frontend keydown handler).

mod engine;

use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;

use tauri::http::{Response, StatusCode};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use engine::{EngineState, check_and_restart, kill_engine, start_engine};

const SHELL_VERSION: u32 = 1;

// ─── error.log rider (Stage 3b polish) ────────────────────────────────────
// Windows: %APPDATA%\scorch\error.log (the by-ear report's contract path).
// Other platforms: XDG data home (or ~/.local/share) — dev convenience only.
#[cfg(target_os = "windows")]
fn error_log_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from).map(|p| p.join("scorch"))
}
#[cfg(not(target_os = "windows"))]
fn error_log_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .map(|p| p.join("scorch"))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share").join("scorch")))
}

/// Append one line to error.log; rotate to error.log.1 past 1 MB so the file
/// can never grow unbounded. Never panics — diagnostics must not kill the app.
#[tauri::command]
fn append_error_log(line: String) -> Result<String, String> {
    let dir = error_log_dir().ok_or_else(|| "no app data dir".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("error.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            let _ = fs::rename(&path, dir.join("error.log.1"));
        }
    }
    use std::io::Write;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Open the webview devtools — wired to the frontend's F12 handler. Works in
/// release builds (the tauri "devtools" cargo feature is enabled in
/// Cargo.toml; if it is ever removed this fails to COMPILE — loud, not a
/// silent no-op).
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Stage 3c-1 — standard VST3 directories for the desktop user. The frontend
/// passes these to the engine's scan message (the engine also has its own
/// defaults for headless/CI use). Windows: %COMMONPROGRAMFILES%\VST3 (per-
/// machine) + %APPDATA%\VST3 (per-user). Non-Windows shells return the POSIX
/// conventions — dev convenience only (the shipped shell is Windows).
#[tauri::command]
fn vst3_paths() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(cf) = std::env::var_os("COMMONPROGRAMFILES") {
        dirs.push(std::path::PathBuf::from(cf).join("VST3").to_string_lossy().into_owned());
    }
    if let Some(ad) = std::env::var_os("APPDATA") {
        dirs.push(std::path::PathBuf::from(ad).join("VST3").to_string_lossy().into_owned());
    }
    dirs
}

/// Stage 3f-3a — the main window's HWND as a plain number. The frontend hands
/// it to the engine ({"type":"setHostWindow","hwnd":<n>}) so engine-owned
/// plugin editor windows can be made OWNED by the app window
/// (SetWindowLongPtrW GWLP_HWNDPARENT engine-side): no taskbar entries,
/// minimize/close with the app, z-ordered above it. Windows-only: other
/// targets return Err and the frontend simply never sends the message (the
/// engine keeps today's floating-window behaviour).
#[tauri::command]
fn main_window_hwnd(app: tauri::AppHandle) -> Result<u64, String> {
    #[cfg(windows)]
    {
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let h = win.hwnd().map_err(|e| format!("no hwnd: {e}"))?;
        Ok(h.0 as u64)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("main_window_hwnd is Windows-only".to_string())
    }
}

fn web_root() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("web"))
}

fn current_version() -> Option<u32> {
    fs::read_to_string(web_root()?.join("CURRENT")).ok()?.trim().parse().ok()
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn resp(status: StatusCode, body: Vec<u8>, mime: Option<&str>) -> Response<Cow<'static, [u8]>> {
    let mut b = Response::builder().status(status);
    if let Some(m) = mime { b = b.header("Content-Type", m); }
    b.body(Cow::Owned(body)).unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let engine_state = EngineState::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine_state)
        .register_uri_scheme_protocol("scorch", |ctx, request| {
            let raw = request.uri().path();
            let path = if raw == "/" || raw.is_empty() { "index.html" } else { raw.trim_start_matches('/') };
            let ext = path.rsplit('.').next().unwrap_or("");

            if path.contains("..") {
                return resp(StatusCode::FORBIDDEN, b"traversal refused".to_vec(), None);
            }

            if let Some(root) = web_root() {
                if let Some(version) = current_version() {
                    let pack_dir = root.join(version.to_string());
                    if let Ok(canonical) = pack_dir.join(path).canonicalize() {
                        if canonical.starts_with(&pack_dir) {
                            if let Ok(content) = fs::read(&canonical) {
                                return resp(StatusCode::OK, content, Some(mime_for(ext)));
                            }
                        }
                    }
                }
            }

            let app = ctx.app_handle();
            if let Some(asset) = app.asset_resolver().get(path.to_string()).or_else(|| app.asset_resolver().get(format!("/{path}"))) {
                return resp(StatusCode::OK, asset.bytes, Some(mime_for(ext)));
            }

            resp(StatusCode::NOT_FOUND, b"not found".to_vec(), None)
        })
        .invoke_handler(tauri::generate_handler![
            engine::get_engine_info,
            append_error_log,
            open_devtools,
            vst3_paths,
            main_window_hwnd
        ])
        .setup(|app| {
            if let Some(version) = current_version() {
                if let Some(root) = web_root() {
                    if let Ok(manifest) = fs::read_to_string(root.join(version.to_string()).join("manifest.json")) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&manifest) {
                            let min_shell = json.get("minShell").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                            if min_shell > SHELL_VERSION {
                                app.dialog().message(format!("This web pack requires Scorch shell v{min_shell} or newer. Please update the app.")).title("Scorch — update required").blocking_show();
                                std::process::exit(1);
                            }
                        }
                    }
                }
            }

            // Spawn the engine sidecar.
            let state: State<'_, EngineState> = app.state();
            start_engine(&state);

            // Background thread: check engine health every 2s, restart if dead.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let state: State<'_, EngineState> = handle.state();
                    check_and_restart(&state);
                }
            });

            let url = if cfg!(debug_assertions) {
                "http://localhost:1420".parse().unwrap()
            } else {
                "scorch://localhost/index.html".parse().unwrap()
            };
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(url))
                .title("Scorch")
                .inner_size(1600.0, 900.0)
                .min_inner_size(1200.0, 700.0)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: State<'_, EngineState> = window.state();
                kill_engine(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
