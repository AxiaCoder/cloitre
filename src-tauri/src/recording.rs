use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::AppError;
use crate::pty::lock;

/// Record type of an output chunk: the bytes as read from the pseudo-terminal.
pub const KIND_OUTPUT: u8 = 1;
/// Record type of a terminal size: columns then rows, each a little-endian `u16`.
pub const KIND_RESIZE: u8 = 2;
/// Record type of a marker set by the user: no data.
pub const KIND_MARKER: u8 = 3;

/// Extension of every recording file.
const EXTENSION: &str = ".rec";

/// Longest time buffered records wait before they are written out, checked at each new record.
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);

/// Size of the write buffer of a recording, in bytes.
const WRITE_BUFFER_SIZE: usize = 64 * 1024;

/// How many suffixed names are tried when two recordings start in the same second.
const NAME_ATTEMPTS: u32 = 100;

/// How many recording files are kept in the folder, the one just created included.
pub const KEPT_RECORDINGS: usize = 20;

/// Largest recording file [`RecordingRegistry::read`] returns, in bytes.
pub const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Writes the records of one session to a sink.
///
/// Each record is `[elapsed ms: u64][type: u8][length: u32][data]`, integers in
/// little-endian, the time counted from the creation of the recorder. The first
/// write error stops the recording for good; the caller is never told, so the
/// session goes on.
pub struct Recorder {
    writer: Option<BufWriter<Box<dyn Write + Send>>>,
    started: Instant,
    last_flush: Instant,
}

/// A recorder shared between the output thread of a session and the commands.
pub type SharedRecorder = Arc<Mutex<Recorder>>;

impl Recorder {
    /// Starts a recording into `sink` and writes the initial size `cols` x `rows` at time 0.
    pub fn new(sink: Box<dyn Write + Send>, cols: u16, rows: u16) -> Self {
        let now = Instant::now();
        let mut recorder = Self {
            writer: Some(BufWriter::with_capacity(WRITE_BUFFER_SIZE, sink)),
            started: now,
            last_flush: now,
        };
        recorder.resize(cols, rows);
        recorder
    }

    /// Tells whether records are still written: false after a write error or [`Recorder::finish`].
    pub fn is_active(&self) -> bool {
        self.writer.is_some()
    }

    /// Records one output chunk, unchanged.
    pub fn output(&mut self, bytes: &[u8]) {
        self.append(KIND_OUTPUT, bytes);
    }

    /// Records a terminal size of `cols` x `rows`.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let mut data = [0u8; 4];
        data[..2].copy_from_slice(&cols.to_le_bytes());
        data[2..].copy_from_slice(&rows.to_le_bytes());
        self.append(KIND_RESIZE, &data);
    }

    /// Records a marker and writes every buffered record out at once.
    pub fn mark(&mut self) {
        self.append(KIND_MARKER, &[]);
        self.flush();
    }

    /// Writes every buffered record out and stops the recording.
    pub fn finish(&mut self) {
        self.flush();
        self.writer = None;
    }

    /// Writes the buffered records out; a failure stops the recording.
    fn flush(&mut self) {
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        if writer.flush().is_err() {
            self.writer = None;
        }
        self.last_flush = Instant::now();
    }

    /// Appends one record of `kind`, then flushes when the last flush is older
    /// than [`FLUSH_INTERVAL`]. Does nothing once the recording stopped.
    fn append(&mut self, kind: u8, data: &[u8]) {
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        let written = u32::try_from(data.len())
            .map_err(io::Error::other)
            .and_then(|length| {
                writer.write_all(&elapsed.to_le_bytes())?;
                writer.write_all(&[kind])?;
                writer.write_all(&length.to_le_bytes())?;
                writer.write_all(data)
            });
        if written.is_err() {
            self.writer = None;
        } else if self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush();
        }
    }
}

/// A recording file of the recordings folder.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RecordingInfo {
    /// File name, without any folder.
    pub name: String,
    /// File size, in bytes.
    pub size: u64,
}

/// A recording just created for a session about to start.
pub struct NewRecording {
    /// File name, without any folder.
    pub name: String,
    /// The recorder the session's output goes to.
    pub recorder: SharedRecorder,
}

/// The recordings folder and the recording of each running session, by session id.
pub struct RecordingRegistry {
    dir: PathBuf,
    enabled: bool,
    active: Mutex<HashMap<u32, NewRecording>>,
}

/// Formats `secs` since the Unix epoch as `YYYYMMDD-HHMMSS`, in UTC.
fn timestamp(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX / 2);
    let of_day = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60
    )
}

/// Tells whether `name` has the exact form of a name this module creates:
/// `YYYYMMDD-HHMMSS.rec` or `YYYYMMDD-HHMMSS-N.rec`, digits only around the dashes.
///
/// No other name is ever read, so no separator, `..`, drive or device name gets through.
pub fn is_recording_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(EXTENSION) else {
        return false;
    };
    let parts: Vec<&str> = stem.split('-').collect();
    let digits = |part: &str, len: Option<usize>| {
        !part.is_empty()
            && part.len() <= 8
            && len.is_none_or(|len| part.len() == len)
            && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    match parts.as_slice() {
        [date, time] => digits(date, Some(8)) && digits(time, Some(6)),
        [date, time, suffix] => {
            digits(date, Some(8)) && digits(time, Some(6)) && digits(suffix, None)
        }
        _ => false,
    }
}

/// Turns an I/O error on a recording into an [`AppError`].
fn io_error(error: &io::Error) -> AppError {
    if error.kind() == io::ErrorKind::NotFound {
        AppError::UnknownRecording
    } else {
        AppError::Recording(error.to_string())
    }
}

impl RecordingRegistry {
    /// Keeps recordings in `dir`, the folder being created with the first
    /// recording. When `enabled` is false nothing is ever recorded and the
    /// folder is never created.
    pub fn new(dir: PathBuf, enabled: bool) -> Self {
        Self {
            dir,
            enabled,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Creates a recording file named after the current UTC time and starts it
    /// at `cols` x `rows`, then deletes the oldest recording files beyond
    /// [`KEPT_RECORDINGS`] (see [`RecordingRegistry::prune`]).
    ///
    /// Returns `None` when recording is disabled, or when the folder or the
    /// file cannot be created: the session then runs unrecorded.
    pub fn create(&self, cols: u16, rows: u16) -> Option<NewRecording> {
        if !self.enabled {
            return None;
        }
        fs::create_dir_all(&self.dir).ok()?;
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let stem = timestamp(secs);
        for attempt in 0..NAME_ATTEMPTS {
            let name = if attempt == 0 {
                format!("{stem}{EXTENSION}")
            } else {
                format!("{stem}-{attempt}{EXTENSION}")
            };
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.dir.join(&name))
            {
                Ok(file) => {
                    let recorder = Recorder::new(Box::new(file), cols, rows);
                    self.prune(&name);
                    return Some(NewRecording {
                        name,
                        recorder: Arc::new(Mutex::new(recorder)),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// Deletes the oldest recording files so that at most [`KEPT_RECORDINGS`]
    /// stay, by name order. Only names [`is_recording_name`] accepts are
    /// touched; `created` and the file of any running session are never
    /// deleted, even when old: a file spared that way leaves more than
    /// [`KEPT_RECORDINGS`] in the folder, and no newer one is deleted in its
    /// place. Failures are ignored.
    fn prune(&self, created: &str) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| is_recording_name(name))
            .collect();
        names.sort_unstable_by(|a, b| b.cmp(a));
        let active: Vec<String> = lock(&self.active)
            .values()
            .map(|recording| recording.name.clone())
            .collect();
        for name in names.iter().skip(KEPT_RECORDINGS) {
            if name != created && !active.contains(name) {
                let _ = fs::remove_file(self.dir.join(name));
            }
        }
    }

    /// Stops `recording` and deletes its file. Used when its session failed to start.
    pub fn discard(&self, recording: &NewRecording) {
        lock(&recording.recorder).finish();
        let _ = fs::remove_file(self.dir.join(&recording.name));
    }

    /// Ties `recording` to session `id`.
    pub fn attach(&self, id: u32, recording: NewRecording) {
        lock(&self.active).insert(id, recording);
    }

    /// Records a new size for session `id`. Does nothing when it has no recording.
    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(recording) = lock(&self.active).get(&id) {
            lock(&recording.recorder).resize(cols, rows);
        }
    }

    /// Records a marker in the recording of session `id` and flushes it.
    ///
    /// # Errors
    /// [`AppError::NoRecording`] when session `id` has no recording, or its recording stopped.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn mark(&self, id: u32) -> Result<(), AppError> {
        let active = lock(&self.active);
        let recording = active.get(&id).ok_or(AppError::NoRecording(id))?;
        let mut recorder = lock(&recording.recorder);
        recorder.mark();
        if recorder.is_active() {
            Ok(())
        } else {
            Err(AppError::NoRecording(id))
        }
    }

    /// Returns the file name of the recording of session `id`, or `None` when
    /// it has none or its recording stopped.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn current(&self, id: u32) -> Option<String> {
        let active = lock(&self.active);
        let recording = active.get(&id)?;
        lock(&recording.recorder)
            .is_active()
            .then(|| recording.name.clone())
    }

    /// Stops the recording of session `id`, if any, and writes it out.
    pub fn finish(&self, id: u32) {
        let removed = lock(&self.active).remove(&id);
        if let Some(recording) = removed {
            lock(&recording.recorder).finish();
        }
    }

    /// Stops every recording. Called when the app exits and when the page reloads.
    pub fn finish_all(&self) {
        let recordings: Vec<NewRecording> = lock(&self.active)
            .drain()
            .map(|(_, recording)| recording)
            .collect();
        for recording in recordings {
            lock(&recording.recorder).finish();
        }
    }

    /// Lists the recording files, newest first. A missing folder gives an empty list.
    ///
    /// # Errors
    /// [`AppError::Recording`] when the folder exists but cannot be read.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn list(&self) -> Result<Vec<RecordingInfo>, AppError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_error(&error)),
        };
        let mut found: Vec<RecordingInfo> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let metadata = entry.metadata().ok()?;
                (is_recording_name(&name) && metadata.is_file()).then_some(RecordingInfo {
                    name,
                    size: metadata.len(),
                })
            })
            .collect();
        found.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(found)
    }

    /// Returns the raw bytes of recording `name`.
    ///
    /// # Errors
    /// [`AppError::InvalidRecordingName`] when `name` is not a name this module
    /// creates; [`AppError::UnknownRecording`] when no such regular file is in
    /// the folder; [`AppError::RecordingTooLarge`] when the file holds more
    /// than [`MAX_READ_BYTES`]; [`AppError::Recording`] when it cannot be read.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn read(&self, name: &str) -> Result<Vec<u8>, AppError> {
        if !is_recording_name(name) {
            return Err(AppError::InvalidRecordingName);
        }
        let path: &Path = &self.dir.join(name);
        let metadata = fs::symlink_metadata(path).map_err(|error| io_error(&error))?;
        if !metadata.is_file() {
            return Err(AppError::UnknownRecording);
        }
        if metadata.len() > MAX_READ_BYTES {
            return Err(AppError::RecordingTooLarge {
                size: metadata.len(),
                limit: MAX_READ_BYTES,
            });
        }
        fs::read(path).map_err(|error| io_error(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One decoded record: elapsed ms, type, data.
    type Record = (u64, u8, Vec<u8>);

    /// Splits a recording file into its records; panics on a malformed file.
    fn decode(mut bytes: &[u8]) -> Vec<Record> {
        let mut records = Vec::new();
        while !bytes.is_empty() {
            let at = u64::from_le_bytes(bytes[..8].try_into().unwrap());
            let kind = bytes[8];
            let length = u32::from_le_bytes(bytes[9..13].try_into().unwrap()) as usize;
            records.push((at, kind, bytes[13..13 + length].to_vec()));
            bytes = &bytes[13 + length..];
        }
        records
    }

    /// The kind and data of each record, without the times.
    fn kinds_and_data(records: &[Record]) -> Vec<(u8, Vec<u8>)> {
        records
            .iter()
            .map(|(_, kind, data)| (*kind, data.clone()))
            .collect()
    }

    /// A sink that accepts `budget` bytes, then fails every write.
    struct FailingSink {
        budget: usize,
    }

    impl Write for FailingSink {
        /// Takes bytes until the budget is spent, then fails.
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.budget == 0 {
                return Err(io::Error::other("disk full"));
            }
            let taken = buf.len().min(self.budget);
            self.budget -= taken;
            Ok(taken)
        }

        /// Does nothing.
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A sink whose bytes stay readable through a clone of it.
    #[derive(Clone, Default)]
    struct SharedSink(Arc<Mutex<Vec<u8>>>);

    impl SharedSink {
        /// The bytes written out so far.
        fn bytes(&self) -> Vec<u8> {
            lock(&self.0).clone()
        }
    }

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

    /// A sink that fails its first flush only, and keeps every byte it accepts.
    struct FailsOnceSink {
        bytes: SharedSink,
        failed: bool,
    }

    impl Write for FailsOnceSink {
        /// Appends every byte.
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.write(buf)
        }

        /// Fails the first time, then succeeds.
        fn flush(&mut self) -> io::Result<()> {
            if self.failed {
                Ok(())
            } else {
                self.failed = true;
                Err(io::Error::other("disk full"))
            }
        }
    }

    /// The recording file shared with the TypeScript decoder tests.
    const FIXTURE: &[u8] = include_bytes!("../../fixtures/recording.rec");

    #[test]
    fn recorder_writes_the_fixture_shared_with_the_typescript_decoder() {
        let sink = SharedSink::default();
        let mut recorder = Recorder::new(Box::new(sink.clone()), 80, 24);
        recorder.output(b"\x1b[2Jhello");
        recorder.output(&[0xe2, 0x94]);
        recorder.output(&[0x80]);
        std::thread::sleep(Duration::from_millis(5));
        recorder.resize(300, 40);
        recorder.mark();
        recorder.output(&[]);
        recorder.finish();

        let mut written = sink.bytes();
        assert_eq!(written.len(), FIXTURE.len());
        let mut offset = 0;
        let mut last_at = 0;
        while offset < FIXTURE.len() {
            let at = u64::from_le_bytes(written[offset..offset + 8].try_into().unwrap());
            assert!(at < 60_000, "time {at} at offset {offset}");
            last_at = at;
            written[offset..offset + 8].copy_from_slice(&FIXTURE[offset..offset + 8]);
            let length = u32::from_le_bytes(FIXTURE[offset + 9..offset + 13].try_into().unwrap());
            offset += 13 + length as usize;
        }
        assert!(last_at >= 5, "last record at {last_at} ms");
        assert_eq!(written, FIXTURE);
    }

    #[test]
    fn initial_size_is_recorded_at_time_zero() {
        let sink = SharedSink::default();
        let mut recorder = Recorder::new(Box::new(sink.clone()), 120, 40);
        recorder.finish();
        assert_eq!(
            decode(&sink.bytes()),
            vec![(0, KIND_RESIZE, vec![120, 0, 40, 0])]
        );
    }

    #[test]
    fn mark_writes_buffered_records_out_at_once() {
        let sink = SharedSink::default();
        let mut recorder = Recorder::new(Box::new(sink.clone()), 80, 24);
        recorder.output(b"before the mark");
        recorder.mark();
        assert_eq!(
            kinds_and_data(&decode(&sink.bytes())),
            vec![
                (KIND_RESIZE, vec![80, 0, 24, 0]),
                (KIND_OUTPUT, b"before the mark".to_vec()),
                (KIND_MARKER, vec![]),
            ]
        );
    }

    #[test]
    fn records_older_than_the_flush_interval_are_written_out_with_the_next_one() {
        let sink = SharedSink::default();
        let mut recorder = Recorder::new(Box::new(sink.clone()), 80, 24);
        recorder.output(b"first");
        std::thread::sleep(FLUSH_INTERVAL + Duration::from_millis(20));
        recorder.output(b"second");
        assert_eq!(
            kinds_and_data(&decode(&sink.bytes())),
            vec![
                (KIND_RESIZE, vec![80, 0, 24, 0]),
                (KIND_OUTPUT, b"first".to_vec()),
                (KIND_OUTPUT, b"second".to_vec()),
            ]
        );
    }

    #[test]
    fn a_failed_write_of_a_large_chunk_stops_recording_at_once() {
        let mut recorder = Recorder::new(Box::new(FailingSink { budget: 0 }), 80, 24);
        recorder.output(&vec![b'x'; WRITE_BUFFER_SIZE + 1]);
        assert!(!recorder.is_active());
    }

    #[test]
    fn nothing_is_written_after_the_first_failure_even_if_the_sink_recovers() {
        let bytes = SharedSink::default();
        let sink = FailsOnceSink {
            bytes: bytes.clone(),
            failed: false,
        };
        let mut recorder = Recorder::new(Box::new(sink), 80, 24);
        recorder.mark();
        let at_failure = bytes.bytes().len();
        recorder.output(b"after the failure");
        recorder.mark();
        recorder.finish();
        assert!(!recorder.is_active());
        assert_eq!(bytes.bytes().len(), at_failure);
    }

    #[test]
    fn create_gives_none_when_the_folder_cannot_be_made() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a-file");
        fs::write(&file, b"x").unwrap();
        let registry = RecordingRegistry::new(file.join("recordings"), true);
        assert!(registry.create(80, 24).is_none());
    }

    #[test]
    fn finish_all_writes_out_and_stops_every_recording() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let first = registry.create(80, 24).unwrap();
        let second = registry.create(80, 24).unwrap();
        let (first_name, second_name) = (first.name.clone(), second.name.clone());
        let first_recorder = Arc::clone(&first.recorder);
        registry.attach(1, first);
        registry.attach(2, second);
        lock(&first_recorder).output(b"pending");
        registry.finish_all();
        assert_eq!(registry.current(1), None);
        assert_eq!(registry.current(2), None);
        assert_eq!(registry.mark(1), Err(AppError::NoRecording(1)));
        assert_eq!(
            kinds_and_data(&decode(&registry.read(&first_name).unwrap())),
            vec![
                (KIND_RESIZE, vec![80, 0, 24, 0]),
                (KIND_OUTPUT, b"pending".to_vec()),
            ]
        );
        assert_eq!(decode(&registry.read(&second_name).unwrap()).len(), 1);
    }

    #[test]
    fn resize_of_a_session_without_recording_does_nothing() {
        let registry = RecordingRegistry::new(PathBuf::from("unused"), true);
        registry.resize(7, 100, 30);
        assert_eq!(registry.current(7), None);
    }

    #[test]
    fn names_with_an_overlong_or_non_digit_suffix_are_refused() {
        assert!(is_recording_name("20261021-153012-99999999.rec"));
        for name in [
            "20261021-153012-123456789.rec",
            "20261021-153012-a.rec",
            "20261021-153012-1 .rec",
            "020261021-153012.rec",
            "20261021-1530120.rec",
            "20261021-153012.REC",
        ] {
            assert!(!is_recording_name(name), "accepted {name:?}");
        }
    }

    #[test]
    fn timestamp_formats_utc_date_and_time() {
        assert_eq!(timestamp(0), "19700101-000000");
        assert_eq!(timestamp(1_700_000_000), "20231114-221320");
        assert_eq!(timestamp(951_782_400), "20000229-000000");
    }

    #[test]
    fn only_generated_names_are_recording_names() {
        assert!(is_recording_name("20261021-153012.rec"));
        assert!(is_recording_name("20261021-153012-2.rec"));
        for name in [
            "",
            ".rec",
            "../20261021-153012.rec",
            "..\\20261021-153012.rec",
            "sub/20261021-153012.rec",
            "C:20261021-153012.rec",
            "CON.rec",
            "20261021-153012.rec.txt",
            "20261021-153012",
            "2026102-153012.rec",
            "20261021-153012-.rec",
            "20261021-153012-1-2.rec",
            "20261021-15301a.rec",
            "20261021-153012..rec",
        ] {
            assert!(!is_recording_name(name), "accepted {name:?}");
        }
    }

    #[test]
    fn recorder_writes_size_output_chunks_and_marker_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().join("recordings"), true);
        let recording = registry.create(80, 24).unwrap();
        let name = recording.name.clone();
        let recorder = Arc::clone(&recording.recorder);
        registry.attach(1, recording);
        lock(&recorder).output(b"\x1b[2Jhello");
        lock(&recorder).output(&[0xe2, 0x94]);
        lock(&recorder).output(&[0x80]);
        registry.resize(1, 100, 30);
        registry.mark(1).unwrap();
        registry.finish(1);

        let records = decode(&registry.read(&name).unwrap());
        assert_eq!(
            kinds_and_data(&records),
            vec![
                (KIND_RESIZE, vec![80, 0, 24, 0]),
                (KIND_OUTPUT, b"\x1b[2Jhello".to_vec()),
                (KIND_OUTPUT, vec![0xe2, 0x94]),
                (KIND_OUTPUT, vec![0x80]),
                (KIND_RESIZE, vec![100, 0, 30, 0]),
                (KIND_MARKER, vec![]),
            ]
        );
        assert!(records.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    }

    #[test]
    fn finish_stops_recording_and_later_output_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let recording = registry.create(80, 24).unwrap();
        let name = recording.name.clone();
        let recorder = Arc::clone(&recording.recorder);
        registry.attach(4, recording);
        assert_eq!(registry.current(4), Some(name.clone()));
        registry.finish(4);
        lock(&recorder).output(b"after the end");
        assert_eq!(registry.current(4), None);
        assert_eq!(decode(&registry.read(&name).unwrap()).len(), 1);
    }

    #[test]
    fn write_failure_stops_recording_without_panicking() {
        let mut recorder = Recorder::new(Box::new(FailingSink { budget: 20 }), 80, 24);
        recorder.output(&[b'x'; 100]);
        recorder.mark();
        assert!(!recorder.is_active());
        recorder.output(b"more");
        recorder.resize(10, 10);
        recorder.finish();
        assert!(!recorder.is_active());
    }

    #[test]
    fn mark_of_a_stopped_recording_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let recording = NewRecording {
            name: "20261021-153012.rec".into(),
            recorder: Arc::new(Mutex::new(Recorder::new(
                Box::new(FailingSink { budget: 0 }),
                80,
                24,
            ))),
        };
        registry.attach(2, recording);
        assert_eq!(registry.mark(2), Err(AppError::NoRecording(2)));
        assert_eq!(registry.current(2), None);
    }

    #[test]
    fn mark_without_recording_is_refused() {
        let registry = RecordingRegistry::new(PathBuf::from("unused"), true);
        assert_eq!(registry.mark(9), Err(AppError::NoRecording(9)));
    }

    #[test]
    fn two_recordings_in_the_same_second_get_distinct_names() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let first = registry.create(80, 24).unwrap();
        let second = registry.create(80, 24).unwrap();
        assert_ne!(first.name, second.name);
        assert!(is_recording_name(&first.name) && is_recording_name(&second.name));
    }

    #[test]
    fn discard_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let recording = registry.create(80, 24).unwrap();
        registry.discard(&recording);
        assert_eq!(registry.list().unwrap(), vec![]);
    }

    #[test]
    fn list_gives_recordings_newest_first_and_skips_other_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("20261021-100000.rec"), b"abc").unwrap();
        fs::write(dir.path().join("20261022-100000.rec"), b"abcdef").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        fs::create_dir(dir.path().join("20261023-100000.rec")).unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        assert_eq!(
            registry.list().unwrap(),
            vec![
                RecordingInfo {
                    name: "20261022-100000.rec".into(),
                    size: 6
                },
                RecordingInfo {
                    name: "20261021-100000.rec".into(),
                    size: 3
                },
            ]
        );
    }

    #[test]
    fn list_of_a_missing_folder_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RecordingRegistry::new(dir.path().join("missing"), true);
        assert_eq!(registry.list().unwrap(), vec![]);
    }

    #[test]
    fn read_refuses_names_outside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        fs::create_dir(&recordings).unwrap();
        fs::write(dir.path().join("20261021-100000.rec"), b"secret").unwrap();
        let registry = RecordingRegistry::new(recordings.clone(), true);
        for name in [
            "../20261021-100000.rec",
            "..\\20261021-100000.rec",
            "..",
            "",
            &dir.path().join("20261021-100000.rec").to_string_lossy(),
        ] {
            assert_eq!(
                registry.read(name),
                Err(AppError::InvalidRecordingName),
                "{name:?}"
            );
        }
        assert_eq!(
            registry.read("20261021-100000.rec"),
            Err(AppError::UnknownRecording)
        );
        fs::create_dir(recordings.join("20261021-110000.rec")).unwrap();
        assert_eq!(
            registry.read("20261021-110000.rec"),
            Err(AppError::UnknownRecording)
        );
    }

    /// Writes `count` recording files dated in 2020, oldest first, and returns their names.
    fn old_recordings(dir: &Path, count: usize) -> Vec<String> {
        (0..count)
            .map(|index| {
                let name = format!("20200101-{index:06}.rec");
                fs::write(dir.join(&name), b"x").unwrap();
                name
            })
            .collect()
    }

    /// The names of the recording files `registry` lists.
    fn listed(registry: &RecordingRegistry) -> Vec<String> {
        registry
            .list()
            .unwrap()
            .into_iter()
            .map(|info| info.name)
            .collect()
    }

    #[test]
    fn a_disabled_registry_records_nothing_and_creates_no_folder() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        let registry = RecordingRegistry::new(recordings.clone(), false);
        assert!(registry.create(80, 24).is_none());
        assert!(!recordings.exists());
    }

    #[test]
    fn creating_a_recording_beyond_the_kept_count_deletes_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let old = old_recordings(dir.path(), KEPT_RECORDINGS);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let created = registry.create(80, 24).unwrap();
        let names = listed(&registry);
        assert_eq!(names.len(), KEPT_RECORDINGS);
        assert_eq!(names[0], created.name);
        assert!(!names.contains(&old[0]));
        assert!(names.contains(&old[1]));
    }

    #[test]
    fn the_recording_of_a_running_session_is_never_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let old = old_recordings(dir.path(), KEPT_RECORDINGS);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        registry.attach(
            1,
            NewRecording {
                name: old[0].clone(),
                recorder: Arc::new(Mutex::new(Recorder::new(
                    Box::new(SharedSink::default()),
                    80,
                    24,
                ))),
            },
        );
        registry.create(80, 24).unwrap();
        let names = listed(&registry);
        assert!(names.contains(&old[0]));
        assert_eq!(names.len(), KEPT_RECORDINGS + 1);
    }

    #[test]
    fn files_that_are_not_recordings_are_never_deleted() {
        let dir = tempfile::tempdir().unwrap();
        old_recordings(dir.path(), KEPT_RECORDINGS);
        fs::write(dir.path().join("00000000-notes.rec"), b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        registry.create(80, 24).unwrap();
        assert!(dir.path().join("00000000-notes.rec").exists());
        assert!(dir.path().join("notes.txt").exists());
        assert_eq!(listed(&registry).len(), KEPT_RECORDINGS);
    }

    #[test]
    fn read_refuses_a_file_over_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = fs::File::create(dir.path().join("20261021-100000.rec")).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        drop(file);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        assert_eq!(
            registry.read("20261021-100000.rec"),
            Err(AppError::RecordingTooLarge {
                size: MAX_READ_BYTES + 1,
                limit: MAX_READ_BYTES,
            })
        );
    }

    #[test]
    fn read_accepts_a_file_of_exactly_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = fs::File::create(dir.path().join("20261021-100000.rec")).unwrap();
        file.set_len(MAX_READ_BYTES).unwrap();
        drop(file);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        let bytes = registry.read("20261021-100000.rec").unwrap();
        assert_eq!(bytes.len() as u64, MAX_READ_BYTES);
    }

    #[test]
    fn creating_the_last_kept_recording_deletes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let old = old_recordings(dir.path(), KEPT_RECORDINGS - 1);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        registry.create(80, 24).unwrap();
        let names = listed(&registry);
        assert_eq!(names.len(), KEPT_RECORDINGS);
        assert!(names.contains(&old[0]));
    }

    #[test]
    fn a_folder_named_like_a_recording_is_neither_deleted_nor_counted() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("20190101-000000.rec");
        fs::create_dir(&folder).unwrap();
        let old = old_recordings(dir.path(), KEPT_RECORDINGS);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        registry.create(80, 24).unwrap();
        assert!(folder.is_dir());
        let names = listed(&registry);
        assert_eq!(names.len(), KEPT_RECORDINGS);
        assert!(!names.contains(&old[0]));
        assert!(names.contains(&old[1]));
    }

    #[test]
    fn a_spared_running_recording_does_not_cost_a_newer_one_its_place() {
        let dir = tempfile::tempdir().unwrap();
        let old = old_recordings(dir.path(), KEPT_RECORDINGS + 1);
        let registry = RecordingRegistry::new(dir.path().to_path_buf(), true);
        registry.attach(
            1,
            NewRecording {
                name: old[0].clone(),
                recorder: Arc::new(Mutex::new(Recorder::new(
                    Box::new(SharedSink::default()),
                    80,
                    24,
                ))),
            },
        );
        registry.create(80, 24).unwrap();
        let names = listed(&registry);
        assert!(names.contains(&old[0]));
        assert!(!names.contains(&old[1]));
        assert!(names.contains(&old[2]));
        assert_eq!(names.len(), KEPT_RECORDINGS + 1);
    }
}
