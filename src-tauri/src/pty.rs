use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::error::AppError;

/// Size of the buffer the reader thread fills before each forward, in bytes.
const READ_BUFFER_SIZE: usize = 8192;

/// One running session: the controlling side of its pseudo-terminal and a handle to stop it.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// The running sessions, by id. Ids start at 1 and are never reused.
#[derive(Default)]
pub struct PtyRegistry {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, PtySession>>,
}

/// Builds a terminal size from columns and rows.
///
/// # Errors
/// [`AppError::InvalidSize`] when either value is zero.
pub fn pty_size(cols: u16, rows: u16) -> Result<PtySize, AppError> {
    if cols == 0 || rows == 0 {
        return Err(AppError::InvalidSize);
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// Turns any displayable error of the pseudo-terminal layer into an [`AppError::Pty`].
fn pty_error(error: impl std::fmt::Display) -> AppError {
    AppError::Pty(error.to_string())
}

impl PtyRegistry {
    /// Opens a pseudo-terminal of `size`, runs `command` in it and registers the session.
    ///
    /// Two threads are started. The reader passes every chunk of raw output bytes
    /// to `on_output`, in order, until the pseudo-terminal closes; chunks may split
    /// a multi-byte character. The waiter calls `on_exit` once with the exit code
    /// when the process ends. The session stays registered after the process
    /// exits: the caller still calls [`PtyRegistry::kill`] to release it.
    ///
    /// # Errors
    /// [`AppError::Pty`] when the pseudo-terminal cannot be opened or the process
    /// cannot be started.
    pub fn spawn(
        &self,
        command: CommandBuilder,
        size: PtySize,
        mut on_output: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32, AppError> {
        let pair = native_pty_system().openpty(size).map_err(pty_error)?;
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = pair.master.take_writer().map_err(pty_error)?;
        let killer = child.clone_killer();

        thread::spawn(move || {
            let mut buffer = [0u8; READ_BUFFER_SIZE];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => on_output(&buffer[..count]),
                }
            }
        });
        thread::spawn(move || {
            let code = child
                .wait()
                .map(|status| status.exit_code())
                .unwrap_or(u32::MAX);
            on_exit(code);
        });

        Ok(self.insert(PtySession {
            master: pair.master,
            writer,
            killer,
        }))
    }

    /// Registers a session and returns its new id.
    fn insert(&self, session: PtySession) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(id, session);
        id
    }

    /// Locks the session map, recovering it if a thread panicked while holding it.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, PtySession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Writes `data` to the input of session `id` and flushes it.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`], or [`AppError::Pty`] when the write fails.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), AppError> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(&id).ok_or(AppError::UnknownPty(id))?;
        session.writer.write_all(data).map_err(pty_error)?;
        session.writer.flush().map_err(pty_error)
    }

    /// Resizes the pseudo-terminal of session `id`.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`], or [`AppError::Pty`] when the resize fails.
    pub fn resize(&self, id: u32, size: PtySize) -> Result<(), AppError> {
        let sessions = self.lock();
        let session = sessions.get(&id).ok_or(AppError::UnknownPty(id))?;
        session.master.resize(size).map_err(pty_error)
    }

    /// Stops the process of session `id` and closes its pseudo-terminal.
    ///
    /// The session is unregistered even when the process had already exited,
    /// which makes the reader thread end.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`].
    pub fn kill(&self, id: u32) -> Result<(), AppError> {
        let mut session = self.lock().remove(&id).ok_or(AppError::UnknownPty(id))?;
        // An already exited process makes kill fail; the session is released either way.
        let _ = session.killer.kill();
        Ok(())
    }

    /// Stops every registered session. Called when the app exits.
    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = self.lock().drain().map(|(_, session)| session).collect();
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn size_refuses_zero_columns_or_rows() {
        assert_eq!(pty_size(0, 24).unwrap_err(), AppError::InvalidSize);
        assert_eq!(pty_size(80, 0).unwrap_err(), AppError::InvalidSize);
    }

    #[test]
    fn size_keeps_columns_and_rows() {
        let size = pty_size(120, 40).unwrap();
        assert_eq!((size.cols, size.rows), (120, 40));
    }

    #[test]
    fn write_to_unknown_id_is_refused() {
        let registry = PtyRegistry::default();
        assert_eq!(registry.write(1, b"x"), Err(AppError::UnknownPty(1)));
    }

    #[test]
    fn resize_of_unknown_id_is_refused() {
        let registry = PtyRegistry::default();
        let size = pty_size(80, 24).unwrap();
        assert_eq!(registry.resize(3, size), Err(AppError::UnknownPty(3)));
    }

    #[test]
    fn kill_of_unknown_id_is_refused() {
        let registry = PtyRegistry::default();
        assert_eq!(registry.kill(2), Err(AppError::UnknownPty(2)));
    }

    #[test]
    fn kill_all_on_empty_registry_does_nothing() {
        PtyRegistry::default().kill_all();
    }

    /// How long a test waits for a short-lived process to print or exit.
    const PROCESS_TIMEOUT: Duration = Duration::from_secs(20);

    /// Builds a command that prints `marker`, then exits with `code`.
    fn print_and_exit(marker: &str, code: u32) -> CommandBuilder {
        if cfg!(windows) {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/C", &format!("echo {marker}& exit /b {code}")]);
            command
        } else {
            let mut command = CommandBuilder::new("sh");
            command.args(["-c", &format!("echo {marker}; exit {code}")]);
            command
        }
    }

    /// Builds a command that waits for about `seconds` without printing anything useful.
    fn wait_quietly(seconds: u32) -> CommandBuilder {
        if cfg!(windows) {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/C", &format!("ping -n {} 127.0.0.1 >NUL", seconds + 1)]);
            command
        } else {
            let mut command = CommandBuilder::new("sh");
            command.args(["-c", &format!("sleep {seconds}")]);
            command
        }
    }

    /// Reads output chunks of session `id` from `receiver` until their concatenation
    /// contains `marker`. Answers the cursor position requests the Windows console
    /// sends before it lets the process print, as a real terminal would.
    fn wait_for_output(
        registry: &PtyRegistry,
        id: u32,
        receiver: &mpsc::Receiver<Vec<u8>>,
        marker: &str,
    ) -> bool {
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        let mut seen = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(chunk) = receiver.recv_timeout(left) else {
                return false;
            };
            if chunk.windows(4).any(|window| window == b"[6n") {
                let _ = registry.write(id, b"[1;1R");
            }
            seen.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&seen).contains(marker) {
                return true;
            }
        }
        false
    }

    #[test]
    fn spawn_forwards_output_and_exit_code() {
        let registry = PtyRegistry::default();
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = registry
            .spawn(
                print_and_exit("cloitre-marker", 3),
                pty_size(80, 24).unwrap(),
                move |bytes| {
                    let _ = output_tx.send(bytes.to_vec());
                },
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .unwrap();
        assert!(wait_for_output(&registry, id, &output_rx, "cloitre-marker"));
        assert_eq!(exit_rx.recv_timeout(PROCESS_TIMEOUT), Ok(3));
        assert_eq!(registry.kill(id), Ok(()));
    }

    #[test]
    fn live_session_accepts_write_and_resize_until_killed() {
        let registry = PtyRegistry::default();
        let id = registry
            .spawn(wait_quietly(10), pty_size(80, 24).unwrap(), |_| {}, |_| {})
            .unwrap();
        assert_eq!(registry.write(id, b"x"), Ok(()));
        assert_eq!(registry.resize(id, pty_size(100, 30).unwrap()), Ok(()));
        assert_eq!(registry.kill(id), Ok(()));
        assert_eq!(registry.write(id, b"x"), Err(AppError::UnknownPty(id)));
        assert_eq!(registry.kill(id), Err(AppError::UnknownPty(id)));
    }

    #[test]
    fn session_ids_are_distinct_and_kill_all_releases_them() {
        let registry = PtyRegistry::default();
        let size = pty_size(80, 24).unwrap();
        let first = registry
            .spawn(wait_quietly(10), size, |_| {}, |_| {})
            .unwrap();
        let second = registry
            .spawn(wait_quietly(10), size, |_| {}, |_| {})
            .unwrap();
        assert_ne!(first, second);
        registry.kill_all();
        assert_eq!(registry.kill(first), Err(AppError::UnknownPty(first)));
        assert_eq!(registry.kill(second), Err(AppError::UnknownPty(second)));
    }
}
