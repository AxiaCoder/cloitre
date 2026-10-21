mod commands;
mod error;
mod folder;
mod launch;
mod pty;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

use crate::pty::PtyRegistry;

/// Tells whether a page load `event` must stop every session: true when the
/// page starts loading, false when it has finished.
fn stops_sessions(event: PageLoadEvent) -> bool {
    event == PageLoadEvent::Started
}

/// Builds and runs the app until its last window closes, then stops every session.
///
/// Every session is also stopped when the page starts loading, so a reload of
/// the webview leaves no `claude` running that the new page cannot reach.
///
/// # Panics
/// When the Tauri runtime cannot start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyRegistry::default())
        .on_page_load(|webview, payload| {
            if stops_sessions(payload.event()) {
                webview.state::<PtyRegistry>().kill_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<PtyRegistry>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_load_start_stops_sessions() {
        assert!(stops_sessions(PageLoadEvent::Started));
    }

    #[test]
    fn page_load_finish_keeps_sessions() {
        assert!(!stops_sessions(PageLoadEvent::Finished));
    }
}
