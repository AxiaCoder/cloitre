mod commands;
mod error;
mod folder;
mod launch;
mod pty;
mod recording;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

use crate::pty::PtyRegistry;
use crate::recording::RecordingRegistry;

/// Tells whether a page load `event` must stop every session: true when the
/// page starts loading, false when it has finished.
fn stops_sessions(event: PageLoadEvent) -> bool {
    event == PageLoadEvent::Started
}

/// Builds and runs the app until its last window closes, then stops every session.
///
/// Every session is also stopped when the page starts loading, so a reload of
/// the webview leaves no `claude` running that the new page cannot reach.
/// Recordings are kept in the `recordings` folder of the app data folder, and
/// closed whenever their sessions are stopped.
///
/// # Panics
/// When the Tauri runtime cannot start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyRegistry::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("recordings");
            app.manage(RecordingRegistry::new(dir));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if stops_sessions(payload.event()) {
                webview.state::<PtyRegistry>().kill_all();
                if let Some(recordings) = webview.try_state::<RecordingRegistry>() {
                    recordings.finish_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::recording_mark,
            commands::recording_current,
            commands::recording_list,
            commands::recording_read
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<PtyRegistry>().kill_all();
                if let Some(recordings) = app.try_state::<RecordingRegistry>() {
                    recordings.finish_all();
                }
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
