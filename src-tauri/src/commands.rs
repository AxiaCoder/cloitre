use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{State, Window};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::launch::{claude_command, resolve_claude};
use crate::projects::{ProjectList, ProjectStore, ProjectView};
use crate::pty::{PtyRegistry, lock, pty_size};
use crate::recording::{RecordingInfo, RecordingRegistry, SharedRecorder};

/// Returns the function every output chunk of a session goes through.
///
/// It is the single point where the raw bytes leave the Rust side: each chunk is
/// first given to `recorder`, when there is one, then sent as is to `channel`.
/// A send fails only once the webview is gone, so the failure is dropped.
fn output_sink(
    channel: Channel<InvokeResponseBody>,
    recorder: Option<SharedRecorder>,
) -> impl FnMut(&[u8]) + Send + 'static {
    move |bytes| {
        if let Some(recorder) = &recorder {
            lock(recorder).output(bytes);
        }
        let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
    }
}

/// Starts `claude` with no argument in `folder`, in a pseudo-terminal of `cols` x `rows`,
/// with `CLOITRE_TAB_ID` set to `tab_id`.
///
/// Raw output bytes are sent to `on_output`; the exit code is sent once to
/// `on_exit`. The session is recorded to a new file of the recordings folder,
/// unless that file cannot be created. Returns the session id.
///
/// # Errors
/// A folder that is not absolute, missing, not a directory or not the folder of
/// a project, or a project whose folder no longer exists; a zero size; a zero
/// tab id;
/// `claude` found neither on the `PATH` nor at its install locations; a
/// pseudo-terminal failure; a page reload at any point after the command is
/// received.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    registry: State<'_, PtyRegistry>,
    recordings: State<'_, RecordingRegistry>,
    projects: State<'_, ProjectStore>,
    folder: String,
    cols: u16,
    rows: u16,
    tab_id: u32,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, AppError> {
    let epoch = registry.epoch();
    let folder = projects.spawn_folder(&folder)?;
    let size = pty_size(cols, rows)?;
    let tab = crate::launch::tab_id(tab_id)?;
    let command = claude_command(&resolve_claude()?, &folder, tab);
    let recording = recordings.create(cols, rows);
    let recorder = recording.as_ref().map(|new| Arc::clone(&new.recorder));
    let spawned = registry.spawn(
        epoch,
        command,
        size,
        output_sink(on_output, recorder),
        move |code| {
            let _ = on_exit.send(code);
        },
    );
    match (spawned, recording) {
        (Ok(id), Some(recording)) => {
            recordings.attach(id, recording);
            Ok(id)
        }
        (Err(error), Some(recording)) => {
            recordings.discard(&recording);
            Err(error)
        }
        (spawned, None) => spawned,
    }
}

/// Writes `data`, encoded as UTF-8, to the input of session `id`.
///
/// # Errors
/// An unknown id, or a failed write.
#[tauri::command(async)]
pub fn pty_write(registry: State<'_, PtyRegistry>, id: u32, data: String) -> Result<(), AppError> {
    registry.write(id, data.as_bytes())
}

/// Records the new size `cols` x `rows` of session `id`, then resizes it.
///
/// # Errors
/// An unknown id, a zero size, or a failed resize.
#[tauri::command(async)]
pub fn pty_resize(
    registry: State<'_, PtyRegistry>,
    recordings: State<'_, RecordingRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    resize_and_record(&registry, &recordings, id, cols, rows)
}

/// Records the size `cols` x `rows` in `recordings`, then resizes session `id`
/// of `registry` to it.
///
/// The size is recorded first, and stays recorded when the resize fails.
///
/// # Errors
/// An unknown id, a zero size, or a failed resize.
fn resize_and_record(
    registry: &PtyRegistry,
    recordings: &RecordingRegistry,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let size = pty_size(cols, rows)?;
    recordings.resize(id, cols, rows);
    registry.resize(id, size)
}

/// Stops session `id`, releases it and closes its recording.
///
/// # Errors
/// An unknown id.
#[tauri::command(async)]
pub fn pty_kill(
    registry: State<'_, PtyRegistry>,
    recordings: State<'_, RecordingRegistry>,
    id: u32,
) -> Result<(), AppError> {
    let killed = registry.kill(id);
    recordings.finish(id);
    killed
}

/// Writes a marker in the recording of session `id`, flushed to disk at once.
///
/// # Errors
/// Session `id` has no recording, or its recording stopped.
#[tauri::command(async)]
pub fn recording_mark(recordings: State<'_, RecordingRegistry>, id: u32) -> Result<(), AppError> {
    recordings.mark(id)
}

/// Returns the file name of the recording of session `id`, or `None` when the
/// session is not being recorded.
#[tauri::command(async)]
pub fn recording_current(recordings: State<'_, RecordingRegistry>, id: u32) -> Option<String> {
    recordings.current(id)
}

/// Lists the recording files with their size in bytes, newest first.
///
/// # Errors
/// The recordings folder exists but cannot be read.
#[tauri::command(async)]
pub fn recording_list(
    recordings: State<'_, RecordingRegistry>,
) -> Result<Vec<RecordingInfo>, AppError> {
    recordings.list()
}

/// Returns the raw bytes of recording `name`, as an `ArrayBuffer` in the webview.
///
/// # Errors
/// A name the app does not create (separators and `..` included); no such
/// file in the recordings folder; a failed read.
#[tauri::command(async)]
pub fn recording_read(
    recordings: State<'_, RecordingRegistry>,
    name: String,
) -> Result<Response, AppError> {
    recordings.read(&name).map(Response::new)
}

/// Lists the projects, each with whether its folder still exists, and the
/// warning left when the project file could not be loaded.
#[tauri::command(async)]
pub fn project_list(projects: State<'_, ProjectStore>) -> ProjectList {
    projects.list()
}

/// Opens the folder picker over `window` and returns the chosen path, or
/// `None` when the user cancels.
///
/// Blocks until the picker closes, so it must not run on the main thread.
fn pick_folder(window: &Window) -> Option<PathBuf> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
}

/// Lets the user pick a folder and adds it as a project.
///
/// Returns the project, the existing one when that folder is already a
/// project, or `None` when the user cancels.
///
/// # Errors
/// A picked folder that cannot be resolved or stored; a read-only project
/// list; a failed save.
#[tauri::command(async)]
pub fn project_add(
    window: Window,
    projects: State<'_, ProjectStore>,
) -> Result<Option<ProjectView>, AppError> {
    pick_folder(&window)
        .map(|folder| projects.add(&folder))
        .transpose()
}

/// Lets the user pick a new folder for project `id`.
///
/// Returns the updated project, or `None` when the user cancels.
///
/// # Errors
/// An unknown id; a picked folder that cannot be resolved or stored, or that
/// is already another project's; a read-only project list; a failed save.
#[tauri::command(async)]
pub fn project_relocate(
    window: Window,
    projects: State<'_, ProjectStore>,
    id: u32,
) -> Result<Option<ProjectView>, AppError> {
    if !projects.list().projects.iter().any(|p| p.id == id) {
        return Err(AppError::UnknownProject(id));
    }
    pick_folder(&window)
        .map(|folder| projects.relocate(id, &folder))
        .transpose()
}

/// Removes project `id` from the list. Its folder is not touched.
///
/// # Errors
/// An unknown id; a read-only project list; a failed save.
#[tauri::command(async)]
pub fn project_remove(projects: State<'_, ProjectStore>, id: u32) -> Result<(), AppError> {
    projects.remove(id)
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::Mutex;

    use super::*;
    use crate::recording::{KIND_RESIZE, NewRecording, Recorder};

    /// A sink whose bytes stay readable through a clone of it.
    #[derive(Clone, Default)]
    struct SharedSink(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedSink {
        /// Appends every byte.
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }

        /// Does nothing.
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn output_sink_records_each_chunk_before_sending_it() {
        let file = SharedSink::default();
        let recorder: SharedRecorder =
            Arc::new(Mutex::new(Recorder::new(Box::new(file.clone()), 80, 24)));
        let seen_at_send = Arc::new(Mutex::new(Vec::new()));
        let channel = {
            let recorder = Arc::clone(&recorder);
            let file = file.clone();
            let seen_at_send = Arc::clone(&seen_at_send);
            Channel::new(move |body| {
                lock(&recorder).mark();
                let recorded = lock(&file.0).clone();
                if let InvokeResponseBody::Raw(sent) = body {
                    lock(&seen_at_send).push((sent, recorded));
                }
                Ok(())
            })
        };
        let mut sink = output_sink(channel, Some(Arc::clone(&recorder)));
        sink(b"chunk");

        let seen = lock(&seen_at_send);
        assert_eq!(seen.len(), 1);
        let (sent, recorded) = &seen[0];
        assert_eq!(sent, b"chunk");
        assert!(
            recorded.windows(5).any(|window| window == b"chunk"),
            "the chunk was sent before it was recorded"
        );
    }

    #[test]
    fn output_sink_without_recorder_still_sends() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let channel = {
            let sent = Arc::clone(&sent);
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    lock(&sent).push(bytes);
                }
                Ok(())
            })
        };
        let mut sink = output_sink(channel, None);
        sink(b"a");
        sink(b"b");
        assert_eq!(*lock(&sent), vec![b"a".to_vec(), b"b".to_vec()]);
    }

    #[test]
    fn resize_is_recorded_even_when_the_pty_refuses_it() {
        let file = SharedSink::default();
        let recordings = RecordingRegistry::new(std::env::temp_dir());
        recordings.attach(
            7,
            NewRecording {
                name: "unused.rec".to_owned(),
                recorder: Arc::new(Mutex::new(Recorder::new(Box::new(file.clone()), 80, 24))),
            },
        );

        let resized = resize_and_record(&PtyRegistry::default(), &recordings, 7, 100, 30);
        recordings.finish(7);

        assert!(resized.is_err());
        let written = lock(&file.0).clone();
        let last = &written[written.len() - 13 - 4..];
        assert_eq!(last[8], KIND_RESIZE);
        assert_eq!(&last[13..], &[100, 0, 30, 0]);
    }
}
