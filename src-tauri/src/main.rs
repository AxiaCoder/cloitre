// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Starts the app, or runs as a hook of a `claude` session without starting
/// Tauri: the `SessionStart` hook when the first argument is `session-hook`,
/// the state hook when it is `state-hook`, or the browser mode (see
/// `cloitre_lib::run_browser_mode`) when a session asks to open a URL.
fn main() {
    let first = std::env::args_os().nth(1);
    if first.as_deref() == Some(std::ffi::OsStr::new(cloitre_lib::HOOK_ARG)) {
        cloitre_lib::run_hook();
        return;
    }
    if first.as_deref() == Some(std::ffi::OsStr::new(cloitre_lib::STATE_HOOK_ARG)) {
        cloitre_lib::run_state_hook();
        return;
    }
    if let Some(code) = cloitre_lib::run_browser_mode() {
        std::process::exit(code);
    }
    cloitre_lib::run()
}
