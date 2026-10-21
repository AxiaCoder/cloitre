use std::sync::Arc;

use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody, Response};

use crate::error::AppError;
use crate::folder::validate_folder;
use crate::launch::{claude_command, resolve_claude};
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

/// Starts `claude` with no argument in `folder`, in a pseudo-terminal of `cols` x `rows`.
///
/// Raw output bytes are sent to `on_output`; the exit code is sent once to
/// `on_exit`. The session is recorded to a new file of the recordings folder,
/// unless that file cannot be created. Returns the session id.
///
/// # Errors
/// A folder that is not absolute, missing or not a directory; a zero size;
/// `claude` missing from the `PATH`; a pseudo-terminal failure.
#[tauri::command(async)]
pub fn pty_spawn(
    registry: State<'_, PtyRegistry>,
    recordings: State<'_, RecordingRegistry>,
    folder: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, AppError> {
    let folder = validate_folder(&folder)?;
    let size = pty_size(cols, rows)?;
    let command = claude_command(&resolve_claude()?, &folder);
    let recording = recordings.create(cols, rows);
    let recorder = recording.as_ref().map(|new| Arc::clone(&new.recorder));
    let spawned = registry.spawn(
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

/// Resizes session `id` to `cols` x `rows`, and records the new size.
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
    registry.resize(id, pty_size(cols, rows)?)?;
    recordings.resize(id, cols, rows);
    Ok(())
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

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::Mutex;

    use super::*;
    use crate::recording::Recorder;

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
}
