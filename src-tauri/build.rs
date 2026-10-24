/// Declares the app's own commands so that they go through the capability system.
///
/// Without this manifest Tauri lets any local window call every command of
/// `invoke_handler`. With it, each command needs its `allow-*` permission in a
/// capability.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pty_spawn",
            "pty_write",
            "pty_resize",
            "pty_kill",
            "recording_enabled",
            "recording_mark",
            "recording_current",
            "recording_list",
            "recording_read",
            "project_list",
            "project_add",
            "project_relocate",
            "project_remove",
            "project_select",
            "tab_open",
            "tab_close",
            "tab_activate",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
