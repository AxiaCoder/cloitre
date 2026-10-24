mod commands;
mod error;
mod folder;
mod launch;
mod projects;
mod pty;
mod recording;
mod session;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::commands::PickerGate;
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

/// Brings the main window of `app` to the front: shown, restored if minimized,
/// and focused. Does nothing when the window does not exist; a step that fails
/// does not prevent the next ones.
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Tells whether a page load `event` must stop every session: true when the
/// page starts loading, false when it has finished.
fn stops_sessions(event: PageLoadEvent) -> bool {
    event == PageLoadEvent::Started
}

/// Gives `config` the identity of this build: its [`session::IDENTIFIER`],
/// and in a development build ` (dev)` after every window title.
fn apply_build_identity(config: &mut tauri::Config) {
    config.identifier = session::IDENTIFIER.to_owned();
    if cfg!(debug_assertions) {
        for window in &mut config.app.windows {
            window.title.push_str(" (dev)");
        }
    }
}

/// Builds and runs the app until its last window closes, then stops every session.
///
/// Only one instance of a build runs: launched while another runs, the app brings that
/// instance's window to the front and exits without opening a window or
/// touching the app data folder.
///
/// Every session is also stopped when the page starts loading, so a reload of
/// the webview leaves no `claude` running that the new page cannot reach.
/// The project list is kept in `projects.json` of the app data folder. At
/// startup the `SessionStart` hook settings are written to `hooks.json` there,
/// and the session ids the hook left in its `sessions` folder are applied.
/// Closing the window while sessions run asks for confirmation first.
/// In a development build, sessions are recorded in its `recordings` folder,
/// and their recordings closed whenever they are stopped; a release build
/// records nothing and registers no `recording_*` command but `recording_enabled`.
///
/// # Panics
/// When the Tauri runtime cannot start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    apply_build_identity(context.config_mut());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyRegistry::default())
        .manage(PickerGate::default())
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
            app.manage(RecordingRegistry::new(
                data.join("recordings"),
                cfg!(debug_assertions),
            ));
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
            commands::recording_enabled,
            #[cfg(debug_assertions)]
            commands::recording_mark,
            #[cfg(debug_assertions)]
            commands::recording_current,
            #[cfg(debug_assertions)]
            commands::recording_list,
            #[cfg(debug_assertions)]
            commands::recording_read,
            commands::project_list,
            commands::project_add,
            commands::project_relocate,
            commands::project_remove,
            commands::project_select,
            commands::project_set_marker,
            commands::tab_open,
            commands::tab_close,
            commands::tab_activate
        ])
        .build(context)
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
    fn build_identity_sets_the_identifier_and_marks_development_titles() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        apply_build_identity(&mut config);
        assert_eq!(config.identifier, session::IDENTIFIER);
        let expected = if cfg!(debug_assertions) {
            "Cloître (dev)"
        } else {
            "Cloître"
        };
        assert_eq!(config.app.windows[0].title, expected);
    }

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
            "allow-recording-enabled",
            "allow-recording-mark",
            "allow-recording-current",
            "allow-recording-list",
            "allow-recording-read",
            "allow-project-list",
            "allow-project-add",
            "allow-project-relocate",
            "allow-project-remove",
            "allow-project-select",
            "allow-project-set-marker",
            "allow-tab-open",
            "allow-tab-close",
            "allow-tab-activate",
        ];
        expected.sort_unstable();
        assert_eq!(granted, expected);
    }

    #[test]
    fn windows_build_ships_exactly_the_bundled_conpty_files() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["resources"],
            serde_json::json!({
                "../vendor/conpty/conpty.dll": "conpty.dll",
                "../vendor/conpty/x64/OpenConsole.exe": "x64/OpenConsole.exe",
                "../vendor/conpty/LICENSE": "conpty-LICENSE.txt",
            })
        );
        for source in config["bundle"]["resources"].as_object().unwrap().keys() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(source);
            assert!(path.is_file(), "missing resource {source}");
        }

        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(shared["bundle"].get("resources").is_none());
    }
}
