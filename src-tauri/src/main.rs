// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Starts the app, or runs as the `SessionStart` hook of a `claude` session
/// when the first argument is `session-hook`, without starting Tauri.
fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(cloitre_lib::HOOK_ARG)) {
        cloitre_lib::run_hook();
        return;
    }
    cloitre_lib::run()
}
