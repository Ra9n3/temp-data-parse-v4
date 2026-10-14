// Scorch desktop shell — thin window + webview, no business logic.
// The entire React app ships unchanged as the frontend; this crate only
// opens the window and hosts the webview. Standing rule: no engine, no
// JUCE, no sidecars, no IPC commands beyond what Tauri provides by default.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
