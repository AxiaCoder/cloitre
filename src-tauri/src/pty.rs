use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::error::AppError;

/// Size of the buffer the reader thread fills before each forward, in bytes.
const READ_BUFFER_SIZE: usize = 8192;

/// How long the exit notice waits, once the process has ended, for the
/// remaining output to be read.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// The controlling side of a pseudo-terminal, shared between the registry and
/// the thread that closes it when the process ends. `None` once closed.
type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// One running session: the controlling side of its pseudo-terminal and a handle to stop it.
struct PtySession {
    master: SharedMaster,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// The running sessions, by id. Ids start at 1 and are never reused.
///
/// The epoch counts the calls to [`PtyRegistry::kill_all`]; it only changes
/// while `sessions` is locked.
#[derive(Default)]
pub struct PtyRegistry {
    next_id: AtomicU32,
    epoch: AtomicU64,
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

/// Locks `mutex`, recovering its value if a thread panicked while holding it.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PtyRegistry {
    /// Opens a pseudo-terminal of `size`, runs `command` in it and registers the session.
    ///
    /// Two threads are started. The reader passes every chunk of raw output bytes
    /// to `on_output`, in order, until the pseudo-terminal closes; chunks may split
    /// a multi-byte character. The waiter, when the process ends, closes the
    /// pseudo-terminal, waits for the reader to finish, then calls `on_exit` once
    /// with the exit code: `on_exit` runs after the last `on_output`, unless the
    /// output is still not drained after [`DRAIN_TIMEOUT`]. The session stays
    /// registered after the process exits: the caller still calls
    /// [`PtyRegistry::kill`] to release it.
    ///
    /// # Errors
    /// [`AppError::Pty`] when the pseudo-terminal cannot be opened or the process
    /// cannot be started; [`AppError::SpawnCancelled`] when
    /// [`PtyRegistry::kill_all`] ran while the session was starting. No process
    /// is left running in either case; a cancelled process still reports its
    /// exit to `on_exit`.
    pub fn spawn(
        &self,
        command: CommandBuilder,
        size: PtySize,
        on_output: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32, AppError> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        self.spawn_in_epoch(epoch, command, size, on_output, on_exit)
    }

    /// Does what [`PtyRegistry::spawn`] does, for a spawn that started in `epoch`:
    /// the session is refused, and its process stopped, unless `epoch` is still
    /// the current one when it is registered.
    ///
    /// # Errors
    /// As [`PtyRegistry::spawn`].
    fn spawn_in_epoch(
        &self,
        epoch: u64,
        command: CommandBuilder,
        size: PtySize,
        mut on_output: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32, AppError> {
        let pair = native_pty_system().openpty(size).map_err(pty_error)?;
        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = pair.master.take_writer().map_err(pty_error)?;
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let master: SharedMaster = Arc::new(Mutex::new(Some(pair.master)));

        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _drained = drained_tx;
            let mut buffer = [0u8; READ_BUFFER_SIZE];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => on_output(&buffer[..count]),
                }
            }
        });
        let waiter_master = Arc::clone(&master);
        thread::spawn(move || {
            let code = child
                .wait()
                .map(|status| status.exit_code())
                .unwrap_or(u32::MAX);
            let closed = lock(&waiter_master).take();
            drop(closed);
            let _ = drained_rx.recv_timeout(DRAIN_TIMEOUT);
            on_exit(code);
        });

        let session = PtySession {
            master,
            writer,
            killer,
        };
        self.insert(epoch, session).map_err(|mut refused| {
            let _ = refused.killer.kill();
            AppError::SpawnCancelled
        })
    }

    /// Registers a session started in `epoch` and returns its new id.
    ///
    /// # Errors
    /// The session itself, unregistered, when `epoch` is no longer the current one.
    fn insert(&self, epoch: u64, session: PtySession) -> Result<u32, PtySession> {
        let mut sessions = lock(&self.sessions);
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err(session);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        sessions.insert(id, session);
        Ok(id)
    }

    /// Writes `data` to the input of session `id` and flushes it. Does nothing
    /// once its process has exited.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`], or [`AppError::Pty`] when the write fails.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), AppError> {
        let mut sessions = lock(&self.sessions);
        let session = sessions.get_mut(&id).ok_or(AppError::UnknownPty(id))?;
        let master = lock(&session.master);
        if master.is_none() {
            return Ok(());
        }
        session.writer.write_all(data).map_err(pty_error)?;
        session.writer.flush().map_err(pty_error)
    }

    /// Resizes the pseudo-terminal of session `id`. Does nothing once its process has exited.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`], or [`AppError::Pty`] when the resize fails.
    pub fn resize(&self, id: u32, size: PtySize) -> Result<(), AppError> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(&id).ok_or(AppError::UnknownPty(id))?;
        match lock(&session.master).as_ref() {
            Some(master) => master.resize(size).map_err(pty_error),
            None => Ok(()),
        }
    }

    /// Stops the process of session `id` and closes its pseudo-terminal.
    ///
    /// The session is unregistered even when the process had already exited,
    /// which makes the reader thread end.
    ///
    /// # Errors
    /// [`AppError::UnknownPty`].
    pub fn kill(&self, id: u32) -> Result<(), AppError> {
        let mut session = lock(&self.sessions)
            .remove(&id)
            .ok_or(AppError::UnknownPty(id))?;
        // An already exited process makes kill fail; the session is released either way.
        let _ = session.killer.kill();
        Ok(())
    }

    /// Stops every registered session. Called when the app exits and when the page reloads.
    ///
    /// A session still starting when this runs is refused and stopped by
    /// [`PtyRegistry::spawn`] instead.
    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = {
            let mut registered = lock(&self.sessions);
            self.epoch.fetch_add(1, Ordering::SeqCst);
            registered.drain().map(|(_, session)| session).collect()
        };
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

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

    /// Answers a cursor position request found in `chunk`, as a real terminal
    /// would: the Windows console sends one before it lets the process print.
    fn answer_cursor_request(registry: &PtyRegistry, id: u32, chunk: &[u8]) {
        if chunk.windows(4).any(|window| window == b"\x1b[6n") {
            let _ = registry.write(id, b"\x1b[1;1R");
        }
    }

    /// Reads output chunks of session `id` from `receiver` until their concatenation
    /// contains `marker`, answering cursor position requests on the way.
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
            answer_cursor_request(registry, id, &chunk);
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

    /// What a session reported, in the order the callbacks ran.
    enum Event {
        Output(Vec<u8>),
        Exit(u32),
    }

    #[test]
    fn exit_is_reported_after_the_last_output() {
        let marker = "cloitre-last-words";
        for _ in 0..10 {
            let registry = PtyRegistry::default();
            let (output_tx, events) = mpsc::channel();
            let exit_tx = output_tx.clone();
            let id = registry
                .spawn(
                    print_and_exit(marker, 0),
                    pty_size(80, 24).unwrap(),
                    move |bytes| {
                        let _ = output_tx.send(Event::Output(bytes.to_vec()));
                    },
                    move |code| {
                        let _ = exit_tx.send(Event::Exit(code));
                    },
                )
                .unwrap();
            let mut seen = Vec::new();
            loop {
                match events.recv_timeout(PROCESS_TIMEOUT) {
                    Ok(Event::Output(chunk)) => {
                        answer_cursor_request(&registry, id, &chunk);
                        seen.extend_from_slice(&chunk);
                    }
                    Ok(Event::Exit(code)) => {
                        assert_eq!(code, 0);
                        break;
                    }
                    Err(error) => panic!("no exit notice: {error}"),
                }
            }
            let text = String::from_utf8_lossy(&seen);
            assert!(
                text.contains(marker),
                "exit came before the output: {text:?}"
            );
            assert!(events.try_recv().is_err(), "output came after the exit");
            let _ = registry.kill(id);
        }
    }

    #[test]
    fn resize_after_exit_is_accepted() {
        let registry = PtyRegistry::default();
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = registry
            .spawn(
                print_and_exit("cloitre-marker", 0),
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
        assert_eq!(exit_rx.recv_timeout(PROCESS_TIMEOUT), Ok(0));
        assert_eq!(registry.resize(id, pty_size(100, 30).unwrap()), Ok(()));
        assert_eq!(registry.kill(id), Ok(()));
    }

    #[test]
    fn write_after_exit_is_accepted() {
        let registry = PtyRegistry::default();
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = registry
            .spawn(
                print_and_exit("cloitre-marker", 0),
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
        assert_eq!(exit_rx.recv_timeout(PROCESS_TIMEOUT), Ok(0));
        assert_eq!(registry.write(id, b"typed after the end"), Ok(()));
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
    fn spawn_overtaken_by_kill_all_is_refused_and_stopped() {
        let registry = PtyRegistry::default();
        let started_in = registry.epoch.load(Ordering::SeqCst);
        registry.kill_all();
        let (exit_tx, exit_rx) = mpsc::channel();
        let spawned = registry.spawn_in_epoch(
            started_in,
            wait_quietly(30),
            pty_size(80, 24).unwrap(),
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        );
        assert_eq!(spawned, Err(AppError::SpawnCancelled));
        assert!(exit_rx.recv_timeout(Duration::from_secs(10)).is_ok());
        assert!(lock(&registry.sessions).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn batch_file_runs_in_the_pseudo_terminal() {
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("claude.cmd");
        std::fs::write(
            &script,
            "@echo cloitre-batch-marker
",
        )
        .unwrap();
        let registry = PtyRegistry::default();
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = registry
            .spawn(
                crate::launch::claude_command(&script, folder.path()),
                pty_size(80, 24).unwrap(),
                move |bytes| {
                    let _ = output_tx.send(bytes.to_vec());
                },
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .unwrap();
        assert!(wait_for_output(
            &registry,
            id,
            &output_rx,
            "cloitre-batch-marker"
        ));
        assert_eq!(exit_rx.recv_timeout(PROCESS_TIMEOUT), Ok(0));
        assert_eq!(registry.kill(id), Ok(()));
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

    #[test]
    fn spawn_after_kill_all_is_registered() {
        let registry = PtyRegistry::default();
        registry.kill_all();
        let id = registry
            .spawn(wait_quietly(10), pty_size(80, 24).unwrap(), |_| {}, |_| {})
            .unwrap();
        assert_eq!(registry.kill(id), Ok(()));
    }
}
