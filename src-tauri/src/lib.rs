mod commands;
mod error;
mod folder;
mod launch;
mod projects;
mod pty;
mod recording;
mod session;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::projects::ProjectStore;
use crate::pty::PtyRegistry;
use crate::recording::RecordingRegistry;
use crate::session::{HookSettings, PendingSessions};

pub use crate::session::{HOOK_ARG, run_hook};

/// Returns the question asked before closing the window while `running`
/// sessions still run, or `None` when none runs and the window closes at once.
fn close_prompt(running: usize) -> Option<String> {
    match running {
        0 => None,
        1 => Some("1 session running. Close anyway?".to_owned()),
        n => Some(format!("{n} sessions running. Close anyway?")),
    }
}

/// Handles a request to close `window`: when sessions still run, the close is
/// prevented through `api` and a native dialog asks for confirmation; the
/// window is destroyed if the user confirms.
///
/// The dialog does not block the calling thread.
fn confirm_close(window: &Window, api: &tauri::CloseRequestApi) {
    let running = window.state::<PtyRegistry>().running_count();
    let Some(prompt) = close_prompt(running) else {
        return;
    };
    api.prevent_close();
    let target = window.clone();
    window
        .dialog()
        .message(prompt)
        .title("Close Cloître")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close".to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |close| {
            if close {
                let _ = target.destroy();
            }
        });
}

/// Tells whether a page load `event` must stop every session: true when the
/// page starts loading, false when it has finished.
fn stops_sessions(event: PageLoadEvent) -> bool {
    event == PageLoadEvent::Started
}

/// Builds and runs the app until its last window closes, then stops every session.
///
/// Every session is also stopped when the page starts loading, so a reload of
/// the webview leaves no `claude` running that the new page cannot reach.
/// The project list is kept in `projects.json` of the app data folder. At
/// startup the `SessionStart` hook settings are written to `hooks.json` there,
/// and the session ids the hook left in its `sessions` folder are applied.
/// Closing the window while sessions run asks for confirmation first.
/// Recordings are kept in its `recordings` folder, and closed whenever their
/// sessions are stopped.
///
/// # Panics
/// When the Tauri runtime cannot start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyRegistry::default())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let projects = ProjectStore::open(data.join("projects.json"));
            let pending = PendingSessions::new(session::sessions_dir(&data));
            pending.apply(&projects);
            let hook = std::env::current_exe()
                .ok()
                .and_then(|exe| session::write_hook_settings(&data, &exe));
            app.manage(projects);
            app.manage(pending);
            app.manage(HookSettings(hook));
            app.manage(RecordingRegistry::new(data.join("recordings")));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                confirm_close(window, api);
            }
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
            commands::recording_read,
            commands::project_list,
            commands::project_add,
            commands::project_relocate,
            commands::project_remove,
            commands::project_select,
            commands::tab_open,
            commands::tab_close
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

    #[test]
    fn closing_asks_only_while_sessions_run() {
        assert_eq!(close_prompt(0), None);
        assert_eq!(
            close_prompt(1).as_deref(),
            Some("1 session running. Close anyway?")
        );
        assert_eq!(
            close_prompt(3).as_deref(),
            Some("3 sessions running. Close anyway?")
        );
    }

    #[test]
    fn main_window_gets_exactly_the_closed_list_of_permissions() {
        let capability_files: Vec<String> =
            std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
        assert_eq!(capability_files, ["default.json"]);

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"].get("capabilities").is_none());

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let mut keys: Vec<&str> = capability
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "$schema",
                "description",
                "identifier",
                "permissions",
                "windows"
            ]
        );
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let mut granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect();
        granted.sort_unstable();
        let mut expected = vec![
            "allow-pty-spawn",
            "allow-pty-write",
            "allow-pty-resize",
            "allow-pty-kill",
            "allow-recording-mark",
            "allow-recording-current",
            "allow-recording-list",
            "allow-recording-read",
            "allow-project-list",
            "allow-project-add",
            "allow-project-relocate",
            "allow-project-remove",
            "allow-project-select",
            "allow-tab-open",
            "allow-tab-close",
        ];
        expected.sort_unstable();
        assert_eq!(granted, expected);
    }
}
