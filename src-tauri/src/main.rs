// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Host-side production smoke: same release binary, no WebView/WebDriver required.
    // Node harness sets OKPGUI_DESKTOP_SMOKE_OUT to a report path and reads the JSON.
    if let Ok(out) = std::env::var("OKPGUI_DESKTOP_SMOKE_OUT") {
        let path = std::path::PathBuf::from(out);
        let code = okpgui_next_lib::desktop_smoke::run_and_write(&path);
        std::process::exit(code);
    }
    okpgui_next_lib::run()
}
