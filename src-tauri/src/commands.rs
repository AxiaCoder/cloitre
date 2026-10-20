use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::AppError;
use crate::folder::validate_folder;
use crate::launch::{claude_command, resolve_claude};
use crate::pty::{PtyRegistry, pty_size};

/// Returns the function every output chunk of a session goes through.
///
/// It is the single point where the raw bytes leave the Rust side: they are sent
/// as is to `channel`. A send fails only once the webview is gone, so the
/// failure is dropped.
fn output_sink(channel: Channel<InvokeResponseBody>) -> impl FnMut(&[u8]) + Send + 'static {
    move |bytes| {
        let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
    }
}

/// Starts `claude` with no argument in `folder`, in a pseudo-terminal of `cols` x `rows`.
///
/// Raw output bytes are sent to `on_output`; the exit code is sent once to
/// `on_exit`. Returns the session id.
///
/// # Errors
/// A folder that is not absolute, missing or not a directory; a zero size;
/// `claude` missing from the `PATH`; a pseudo-terminal failure.
#[tauri::command]
pub fn pty_spawn(
    registry: State<'_, PtyRegistry>,
    folder: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, AppError> {
    let folder = validate_folder(&folder)?;
    let size = pty_size(cols, rows)?;
    let command = claude_command(&resolve_claude()?, &folder);
    registry.spawn(command, size, output_sink(on_output), move |code| {
        let _ = on_exit.send(code);
    })
}

/// Writes `data`, encoded as UTF-8, to the input of session `id`.
///
/// # Errors
/// An unknown id, or a failed write.
#[tauri::command]
pub fn pty_write(registry: State<'_, PtyRegistry>, id: u32, data: String) -> Result<(), AppError> {
    registry.write(id, data.as_bytes())
}

/// Resizes session `id` to `cols` x `rows`.
///
/// # Errors
/// An unknown id, a zero size, or a failed resize.
#[tauri::command]
pub fn pty_resize(
    registry: State<'_, PtyRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    registry.resize(id, pty_size(cols, rows)?)
}

/// Stops session `id` and releases it.
///
/// # Errors
/// An unknown id.
#[tauri::command]
pub fn pty_kill(registry: State<'_, PtyRegistry>, id: u32) -> Result<(), AppError> {
    registry.kill(id)
}
