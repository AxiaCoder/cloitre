use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::Read;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::launch::TAB_ID_VAR;
use crate::projects::{ProjectStore, write_file_atomically};
use crate::state::{ASK_TOOL, STATE_HOOK_ARG, STATE_HOOK_EVENTS};

/// The app identifier of `tauri.conf.json`, kept by a release build.
pub const RELEASE_IDENTIFIER: &str = "com.cloitre.desktop";

/// The app identifier of this build, which names its app data folder and its
/// single-instance lock: [`RELEASE_IDENTIFIER`] in a release build, the same
/// with `.dev` appended in a development build.
pub const IDENTIFIER: &str = if cfg!(debug_assertions) {
    "com.cloitre.desktop.dev"
} else {
    RELEASE_IDENTIFIER
};

/// The first argument that starts the app's executable as a `SessionStart` hook
/// instead of the app.
pub const HOOK_ARG: &str = "session-hook";

/// Name of the Claude Code settings file the app writes in its data folder.
const HOOK_SETTINGS_FILE: &str = "hooks.json";

/// Name of the folder, in the app data folder, where the hook leaves the
/// session id of each tab.
const SESSIONS_FOLDER: &str = "sessions";

/// The most bytes the hook reads from its standard input.
const HOOK_INPUT_LIMIT: u64 = 1 << 20;

/// A Claude Code session id: 36 characters, hexadecimal digits and hyphens at
/// the places of a UUID, stored in lower case.
///
/// Its first character is never `-`, so `claude` never reads it as an option,
/// and it holds no character `cmd.exe` interprets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SessionId(String);

impl SessionId {
    /// Returns a new random (version 4) session id.
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().hyphenated().to_string())
    }

    /// Checks the form of `text` and returns it as a session id, in lower case.
    /// Upper-case hexadecimal digits are accepted.
    ///
    /// Returns `None` for any other length, a hyphen out of place or any
    /// character that is neither a hexadecimal digit nor such a hyphen.
    pub fn parse(text: &str) -> Option<Self> {
        let well_formed = text.len() == 36
            && text.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        well_formed.then(|| Self(text.to_ascii_lowercase()))
    }

    /// Returns the id as text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SessionId {
    /// Writes the id as text.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for SessionId {
    type Error = String;

    /// Checks `value` with [`SessionId::parse`].
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value).ok_or_else(|| format!("not a session id: {value:?}"))
    }
}

impl From<SessionId> for String {
    /// Returns the id as text.
    fn from(id: SessionId) -> Self {
        id.0
    }
}

/// How `pty_spawn` starts `claude`: the closed list of launch modes the webview
/// may ask for. Any other value is refused when the command arguments are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// A new conversation, under a new session id.
    New,
    /// The tab's last conversation, under its stored session id.
    Resume,
}

/// Returns the app data folder the way Tauri computes it for
/// `app_data_dir`: the platform data folder joined with [`IDENTIFIER`]
/// (`%APPDATA%\com.cloitre.desktop` on Windows for a release build).
/// `None` when the platform data folder is unknown.
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(IDENTIFIER))
}

/// Tells whether `text` may stand between double quotes in a command line that
/// `cmd.exe` or a POSIX shell parses, with no character either one interprets.
fn is_command_line_safe(text: &str) -> bool {
    !text.chars().any(|c| {
        c.is_control() || matches!(c, '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>' | '$' | '`')
    })
}

/// Returns the content of the Claude Code settings file that runs `exe` with
/// [`HOOK_ARG`] on every `SessionStart`, and with [`STATE_HOOK_ARG`] on every
/// event of [`STATE_HOOK_EVENTS`] and on `PreToolUse` for [`ASK_TOOL`].
///
/// Each command is `"<exe>" <argument>`, with `exe` written with `/`
/// separators. `None` when that path holds a character a shell would
/// interpret, or is not valid Unicode.
pub fn hook_settings(exe: &Path) -> Option<String> {
    let exe = exe.to_str()?.replace('\\', "/");
    if !is_command_line_safe(&exe) {
        return None;
    }
    let run = |argument: &str| {
        serde_json::json!([{ "type": "command", "command": format!("\"{exe}\" {argument}") }])
    };
    let mut hooks = serde_json::Map::new();
    hooks.insert(
        "SessionStart".to_owned(),
        serde_json::json!([{ "hooks": run(HOOK_ARG) }]),
    );
    for event in STATE_HOOK_EVENTS {
        hooks.insert(
            event.to_owned(),
            serde_json::json!([{ "hooks": run(STATE_HOOK_ARG) }]),
        );
    }
    hooks.insert(
        "PreToolUse".to_owned(),
        serde_json::json!([{ "matcher": ASK_TOOL, "hooks": run(STATE_HOOK_ARG) }]),
    );
    Some(serde_json::json!({ "hooks": hooks }).to_string())
}

/// Writes the hook settings file for `exe` in `data_dir` and returns its path,
/// to pass to `claude --settings`.
///
/// `None`, and nothing written, when [`hook_settings`] refuses `exe`, when the
/// file path holds a character a shell would interpret, or when the write
/// fails: sessions then start without the hook.
pub fn write_hook_settings(data_dir: &Path, exe: &Path) -> Option<PathBuf> {
    let file = data_dir.join(HOOK_SETTINGS_FILE);
    if !is_command_line_safe(file.to_str()?) {
        return None;
    }
    let content = hook_settings(exe)?;
    write_file_atomically(&file, content.as_bytes()).ok()?;
    Some(file)
}

/// Returns the folder where the hook leaves session ids, inside `data_dir`.
pub fn sessions_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SESSIONS_FOLDER)
}

/// Reads the tab id from `value`, the [`TAB_ID_VAR`] variable: a decimal
/// integer from 1 to 4294967295. `None` otherwise.
pub(crate) fn parse_tab_id(value: &OsStr) -> Option<NonZeroU32> {
    let text = value.to_str()?;
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Handles one `SessionStart` notice: `input` is the JSON Claude Code sends on
/// the hook's standard input, `tab_var` the value of [`TAB_ID_VAR`].
///
/// Writes the `session_id` of `input` to the file `<sessions_dir>/<tab id>`,
/// atomically, and returns true. Writes nothing and returns false when `input`
/// is not JSON, has no valid `session_id`, when `tab_var` is not a tab id, or
/// when the write fails.
pub fn record_session(input: &[u8], tab_var: Option<&OsStr>, sessions_dir: &Path) -> bool {
    let Some(tab) = tab_var.and_then(parse_tab_id) else {
        return false;
    };
    let Ok(notice) = serde_json::from_slice::<serde_json::Value>(input) else {
        return false;
    };
    let Some(id) = notice
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .and_then(SessionId::parse)
    else {
        return false;
    };
    write_file_atomically(&sessions_dir.join(tab.to_string()), id.as_str().as_bytes()).is_ok()
}

/// Runs the app's executable as a `SessionStart` hook: reads the notice on the
/// standard input and records its session id for the tab named by
/// [`TAB_ID_VAR`], in the `sessions` folder of [`app_data_dir`].
///
/// Never fails and never prints: whatever happens, `claude` goes on.
pub fn run_hook() {
    let mut input = Vec::new();
    if std::io::stdin()
        .take(HOOK_INPUT_LIMIT)
        .read_to_end(&mut input)
        .is_err()
    {
        return;
    }
    if let Some(data_dir) = app_data_dir() {
        record_session(
            &input,
            std::env::var_os(TAB_ID_VAR).as_deref(),
            &sessions_dir(&data_dir),
        );
    }
}

/// The hook settings file passed to every `claude` session, or `None` when it
/// could not be written and sessions start without the hook.
#[derive(Debug)]
pub struct HookSettings(pub Option<PathBuf>);

/// The session ids the hook left for the app to apply, in the `sessions` folder.
#[derive(Debug)]
pub struct PendingSessions {
    dir: PathBuf,
}

impl PendingSessions {
    /// Uses `dir` as the folder the hook writes to.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Stores, as the session id of its tab in `store`, every id the hook left,
    /// then deletes its file.
    ///
    /// Only files named by a decimal number are read, so the hook's temporary
    /// files are left alone. Each file is first renamed to `<n>.applying`, so
    /// an id the hook writes for the same tab meanwhile stays for the next
    /// apply. A file that does not hold exactly a session id, or names no tab
    /// of `store`, is deleted and ignored. A file whose id could not be saved
    /// goes back under its name, unless the hook wrote a newer one there.
    pub fn apply(&self, store: &ProjectStore) {
        self.apply_with(|tab, id| store.set_session(tab, id));
    }

    /// Does what [`Self::apply`] does, storing each id with `save`, which
    /// receives the tab id and the session id.
    fn apply_with(&self, mut save: impl FnMut(u32, SessionId) -> Result<(), AppError>) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(text) = name
                .to_str()
                .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            else {
                continue;
            };
            let path = entry.path();
            let claimed = self.dir.join(format!("{text}.applying"));
            if fs::rename(&path, &claimed).is_err() {
                continue;
            }
            let tab = parse_tab_id(&name);
            let id = fs::read_to_string(&claimed)
                .ok()
                .and_then(|text| SessionId::parse(&text));
            let saved = match (tab, id) {
                (Some(tab), Some(id)) => save(tab.get(), id),
                _ => Ok(()),
            };
            if saved.is_err() {
                put_back(&claimed, &path, |from, to| fs::hard_link(from, to));
            } else {
                let _ = fs::remove_file(&claimed);
            }
        }
    }

    /// Deletes the id the hook left for tab `tab`, if any.
    pub fn discard(&self, tab: u32) {
        let _ = fs::remove_file(self.dir.join(tab.to_string()));
    }
}

/// Moves the claimed file `claimed` back to `path`, unless the hook wrote a
/// newer file there, in which case `claimed` is deleted.
///
/// `link` is tried first, so a file the hook writes meanwhile is not
/// replaced; when it fails and `path` is still free, `claimed` is renamed
/// instead. `claimed` stays in place only if that rename fails too.
fn put_back(claimed: &Path, path: &Path, link: impl FnOnce(&Path, &Path) -> std::io::Result<()>) {
    if link(claimed, path).is_err() && !path.exists() {
        let _ = fs::rename(claimed, path);
        return;
    }
    let _ = fs::remove_file(claimed);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f";

    #[test]
    fn a_generated_id_has_the_checked_form() {
        let id = SessionId::generate();
        assert_eq!(SessionId::parse(id.as_str()), Some(id.clone()));
        assert_eq!(id.as_str(), id.as_str().to_ascii_lowercase());
        assert_ne!(SessionId::generate(), id);
    }

    #[test]
    fn upper_case_digits_are_accepted_and_lowered() {
        let id = SessionId::parse(&SAMPLE.to_ascii_uppercase()).unwrap();
        assert_eq!(id.as_str(), SAMPLE);
    }

    #[test]
    fn a_malformed_id_is_refused() {
        for bad in [
            "",
            "-0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6",
            "-x8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f",
            "-f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f",
            "0f8e5c1a03b2d04c6e09a7f01d2c3b4a5e6f",
            "--resume",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f0",
            "0f8e5c1a3b2d-4c6e-9a7f-1d2c3b4a5e6f0",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6g",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e&f",
            " 0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6\n",
            "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5é",
        ] {
            assert_eq!(SessionId::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn deserialising_checks_the_form() {
        assert!(serde_json::from_str::<SessionId>("\"not-an-id\"").is_err());
        let id: SessionId = serde_json::from_str(&format!("\"{SAMPLE}\"")).unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{SAMPLE}\""));
    }

    #[test]
    fn launch_mode_is_a_closed_list() {
        assert_eq!(
            serde_json::from_str::<LaunchMode>("\"new\"").unwrap(),
            LaunchMode::New
        );
        assert_eq!(
            serde_json::from_str::<LaunchMode>("\"resume\"").unwrap(),
            LaunchMode::Resume
        );
        for other in ["\"New\"", "\"continue\"", "\"\"", "1", "null"] {
            assert!(
                serde_json::from_str::<LaunchMode>(other).is_err(),
                "{other}"
            );
        }
    }

    #[test]
    fn release_identifier_is_the_one_of_the_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], RELEASE_IDENTIFIER);
    }

    #[test]
    fn development_build_has_its_own_identifier() {
        if cfg!(debug_assertions) {
            assert_eq!(IDENTIFIER, "com.cloitre.desktop.dev");
        } else {
            assert_eq!(IDENTIFIER, RELEASE_IDENTIFIER);
        }
    }

    #[test]
    fn app_data_dir_is_the_platform_data_folder_plus_the_identifier() {
        let expected = dirs::data_dir().map(|dir| dir.join(IDENTIFIER));
        assert_eq!(app_data_dir(), expected);
        #[cfg(windows)]
        assert_eq!(
            app_data_dir(),
            std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join(IDENTIFIER))
        );
    }

    #[test]
    fn hook_command_quotes_the_executable_with_forward_slashes() {
        let settings = hook_settings(Path::new(r"C:\Program Files\Cloitre\cloitre.exe")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&settings).unwrap();
        let state = serde_json::json!([{ "hooks": [{
            "type": "command",
            "command": "\"C:/Program Files/Cloitre/cloitre.exe\" state-hook"
        }] }]);
        assert_eq!(
            value,
            serde_json::json!({
                "hooks": {
                    "SessionStart": [{ "hooks": [{
                        "type": "command",
                        "command": "\"C:/Program Files/Cloitre/cloitre.exe\" session-hook"
                    }] }],
                    "PermissionRequest": state,
                    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{
                        "type": "command",
                        "command": "\"C:/Program Files/Cloitre/cloitre.exe\" state-hook"
                    }] }],
                    "Elicitation": state,
                    "UserPromptSubmit": state,
                    "PostToolUse": state,
                    "PostToolUseFailure": state,
                    "ElicitationResult": state,
                    "Stop": state,
                }
            })
        );
    }

    #[test]
    fn hook_is_not_written_for_a_path_a_shell_would_interpret() {
        for exe in [
            r"C:\a&b\cloitre.exe",
            r"C:\100%\cloitre.exe",
            "/opt/$HOME/cloitre",
            "/opt/`id`/cloitre",
            "/opt/\"x\"/cloitre",
        ] {
            assert_eq!(hook_settings(Path::new(exe)), None, "{exe}");
        }
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            write_hook_settings(dir.path(), Path::new("/opt/$x/cloitre")),
            None
        );
        assert!(!dir.path().join(HOOK_SETTINGS_FILE).exists());
    }

    #[test]
    fn hook_settings_file_is_written_in_the_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let file = write_hook_settings(&data, Path::new("/opt/cloitre/cloitre")).unwrap();
        assert_eq!(file, data.join("hooks.json"));
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            hook_settings(Path::new("/opt/cloitre/cloitre")).unwrap()
        );
    }

    /// Builds the JSON a `SessionStart` hook receives, with `session_id`.
    fn notice(session_id: &str) -> Vec<u8> {
        serde_json::json!({
            "session_id": session_id,
            "transcript_path": "/tmp/t.jsonl",
            "cwd": "/projects/example",
            "hook_event_name": "SessionStart",
            "source": "clear"
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn a_valid_notice_writes_the_tab_file() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        assert!(record_session(
            &notice(&SAMPLE.to_ascii_uppercase()),
            Some(OsStr::new("7")),
            &sessions
        ));
        assert_eq!(fs::read_to_string(sessions.join("7")).unwrap(), SAMPLE);
        let names: Vec<_> = fs::read_dir(&sessions).unwrap().collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn an_invalid_notice_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let cases: [(&[u8], Option<&str>); 9] = [
            (b"not json", Some("7")),
            (b"{}", Some("7")),
            (br#"{"session_id": 12}"#, Some("7")),
            (&notice("../../escape"), Some("7")),
            (&notice(SAMPLE), None),
            (&notice(SAMPLE), Some("0")),
            (&notice(SAMPLE), Some("-1")),
            (&notice(SAMPLE), Some("../7")),
            (&notice(SAMPLE), Some("4294967296")),
        ];
        for (input, tab) in cases {
            assert!(!record_session(input, tab.map(OsStr::new), &sessions));
        }
        assert!(!sessions.exists());
    }

    /// A store in `dir` with one project and one tab, and that tab's id.
    fn store_with_a_tab(dir: &Path) -> (ProjectStore, u32) {
        let folder = dir.join("project");
        fs::create_dir_all(&folder).unwrap();
        let store = ProjectStore::open(dir.join("projects.json"));
        let project = store.add(&folder).unwrap();
        let tab = store.open_tab(project.id).unwrap().id;
        (store, tab)
    }

    #[test]
    fn a_pending_session_id_becomes_the_tabs_and_its_file_goes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tab) = store_with_a_tab(dir.path());
        let sessions = sessions_dir(dir.path());
        assert!(record_session(
            &notice(SAMPLE),
            Some(OsStr::new(&tab.to_string())),
            &sessions
        ));
        PendingSessions::new(sessions.clone()).apply(&store);
        let (_, resumed) = store.launch(tab, LaunchMode::Resume).unwrap();
        assert_eq!(resumed.as_str(), SAMPLE);
        assert!(!sessions.join(tab.to_string()).exists());
        let (_, reloaded) = ProjectStore::open(dir.path().join("projects.json"))
            .launch(tab, LaunchMode::Resume)
            .unwrap();
        assert_eq!(reloaded.as_str(), SAMPLE);
    }

    #[test]
    fn an_invalid_pending_file_is_deleted_and_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tab) = store_with_a_tab(dir.path());
        let (_, before) = store.launch(tab, LaunchMode::Resume).unwrap();
        let sessions = sessions_dir(dir.path());
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join(tab.to_string()),
            "--dangerously-skip-permissions",
        )
        .unwrap();
        fs::write(sessions.join("99"), SAMPLE).unwrap();
        fs::write(sessions.join("0"), SAMPLE).unwrap();
        fs::write(sessions.join("5.1234.tmp"), SAMPLE).unwrap();
        PendingSessions::new(sessions.clone()).apply(&store);
        let (_, after) = store.launch(tab, LaunchMode::Resume).unwrap();
        assert_eq!(after, before);
        let left: Vec<String> = fs::read_dir(&sessions)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["5.1234.tmp"]);
    }

    #[test]
    fn a_missing_sessions_folder_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tab) = store_with_a_tab(dir.path());
        let (_, before) = store.launch(tab, LaunchMode::Resume).unwrap();
        PendingSessions::new(dir.path().join("nowhere")).apply(&store);
        assert_eq!(store.launch(tab, LaunchMode::Resume).unwrap().1, before);
    }

    #[test]
    fn a_pending_id_that_cannot_be_saved_stays_for_the_next_apply() {
        let dir = tempfile::tempdir().unwrap();
        let (store, tab) = store_with_a_tab(dir.path());
        let (_, before) = store.launch(tab, LaunchMode::Resume).unwrap();
        let sessions = sessions_dir(dir.path());
        assert!(record_session(
            &notice(SAMPLE),
            Some(OsStr::new(&tab.to_string())),
            &sessions
        ));
        let blocker = dir
            .path()
            .join(format!("projects.json.{}.tmp", std::process::id()));
        fs::create_dir(&blocker).unwrap();
        let pending = PendingSessions::new(sessions.clone());

        pending.apply(&store);
        assert_eq!(store.launch(tab, LaunchMode::Resume).unwrap().1, before);
        assert_eq!(file_names(&sessions), [tab.to_string()]);

        fs::remove_dir(&blocker).unwrap();
        pending.apply(&store);
        assert_eq!(
            store.launch(tab, LaunchMode::Resume).unwrap().1.as_str(),
            SAMPLE
        );
        assert!(!sessions.join(tab.to_string()).exists());
    }

    /// The names of the files left in `dir`.
    fn file_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    const NEWER: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

    #[test]
    fn an_id_the_hook_writes_during_an_apply_stays_for_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = sessions_dir(dir.path());
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("3"), SAMPLE).unwrap();
        let mut applied = Vec::new();
        PendingSessions::new(sessions.clone()).apply_with(|tab, id| {
            fs::write(sessions.join("3"), NEWER).unwrap();
            applied.push((tab, id));
            Ok(())
        });
        assert_eq!(applied, [(3, SessionId::parse(SAMPLE).unwrap())]);
        assert_eq!(fs::read_to_string(sessions.join("3")).unwrap(), NEWER);
        assert_eq!(file_names(&sessions), ["3"]);
    }

    #[test]
    fn a_failed_apply_leaves_the_newer_id_the_hook_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = sessions_dir(dir.path());
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("3"), SAMPLE).unwrap();
        PendingSessions::new(sessions.clone()).apply_with(|_, _| {
            fs::write(sessions.join("3"), NEWER).unwrap();
            Err(AppError::UnknownTab(3))
        });
        assert_eq!(fs::read_to_string(sessions.join("3")).unwrap(), NEWER);
        assert_eq!(file_names(&sessions), ["3"]);
    }

    #[test]
    fn an_unsaved_id_goes_back_under_its_name_without_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let claimed = dir.path().join("3.applying");
        let path = dir.path().join("3");
        fs::write(&claimed, SAMPLE).unwrap();
        put_back(&claimed, &path, |_, _| {
            Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
        });
        assert_eq!(fs::read_to_string(&path).unwrap(), SAMPLE);
        assert_eq!(file_names(dir.path()), ["3"]);
    }

    #[test]
    fn discarding_removes_only_that_tabs_file() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = sessions_dir(dir.path());
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("3"), SAMPLE).unwrap();
        fs::write(sessions.join("4"), SAMPLE).unwrap();
        let pending = PendingSessions::new(sessions.clone());
        pending.discard(3);
        pending.discard(8);
        assert!(!sessions.join("3").exists());
        assert!(sessions.join("4").exists());
    }
}
