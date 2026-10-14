// Scorch desktop shell — thin window + webview.
// Stage 2: scorch:// protocol serves from <exe-dir>/web/<version>/ (hot-swap
// tier) with path-traversal protection, minShell handshake, and graceful
// fallback to the bundled dist/ embedded in the binary.

use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;

use tauri::http::{Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const SHELL_VERSION: u32 = 1;

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

/// Build a Response with the given status, body, and optional Content-Type.
fn resp(status: StatusCode, body: Vec<u8>, mime: Option<&str>) -> Response<Cow<'static, [u8]>> {
    let mut b = Response::builder().status(status);
    if let Some(m) = mime {
        b = b.header("Content-Type", m);
    }
    b.body(Cow::Owned(body)).unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("scorch", |ctx, request| {
            let raw = request.uri().path();
            let path = if raw == "/" || raw.is_empty() { "index.html" } else { raw.trim_start_matches('/') };
            let ext = path.rsplit('.').next().unwrap_or("");

            if path.contains("..") {
                return resp(StatusCode::FORBIDDEN, b"traversal refused".to_vec(), None);
            }

            // External pack: <exe-dir>/web/<version>/<path>, traversal-guarded by canonicalize + starts_with.
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

            // Fallback: bundled dist embedded at compile time.
            let app = ctx.app_handle();
            if let Some(asset) = app.asset_resolver().get(path.to_string()).or_else(|| app.asset_resolver().get(format!("/{path}"))) {
                return resp(StatusCode::OK, asset.bytes, Some(mime_for(ext)));
            }

            resp(StatusCode::NOT_FOUND, b"not found".to_vec(), None)
        })
        .setup(|app| {
            // Handshake: if a pack exists but requires a newer shell, dialog + exit.
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
