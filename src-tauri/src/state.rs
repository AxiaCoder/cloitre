#[cfg(windows)]
mod windows;

use std::ffi::OsStr;
use std::io::Read;
use std::num::NonZeroU32;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::launch::TAB_ID_VAR;
use crate::session::parse_tab_id;

/// The first argument that starts the app's executable as the hook that tells
/// the running app the state of a tab's session, instead of the app.
pub const STATE_HOOK_ARG: &str = "state-hook";

/// The Tauri event the app emits to the webview for every valid state message,
/// with a [`StateMessage`] as payload.
pub const SESSION_STATE_EVENT: &str = "session-state";

/// The Claude Code hook events the state hook runs on for every tool or
/// server, with no matcher.
pub const STATE_HOOK_EVENTS: [&str; 7] = [
    "PermissionRequest",
    "Elicitation",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "ElicitationResult",
    "Stop",
];

/// The tool whose `PreToolUse` event means the session waits for an answer;
/// the state hook runs on `PreToolUse` with this tool name as matcher.
pub const ASK_TOOL: &str = "AskUserQuestion";

/// The most bytes the hook reads from its standard input.
const HOOK_INPUT_LIMIT: u64 = 1 << 20;

/// The most bytes a state message may hold, final newline included. A longer
/// message is dropped.
pub const MESSAGE_LIMIT: usize = 256;

/// What a tab's session is doing, as told by its hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    /// Waits for the user: a permission, a question or an elicitation.
    Blocked,
    /// Works on a prompt.
    Working,
    /// Has finished answering.
    Done,
}

/// One state message: the tab id and the state of its session. Sent by the
/// hook as one JSON line, `{"tab":3,"state":"blocked"}`, and emitted to the
/// webview in the same form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateMessage {
    /// The tab id, from 1.
    pub tab: NonZeroU32,
    /// The state of the tab's session.
    pub state: SessionState,
}

/// Returns the state a hook event means: `event` is its `hook_event_name`,
/// `tool` its `tool_name` when it has one. `None` for any event that tells
/// nothing about the state.
pub fn state_for(event: &str, tool: Option<&str>) -> Option<SessionState> {
    match event {
        "PermissionRequest" | "Elicitation" => Some(SessionState::Blocked),
        "PreToolUse" if tool == Some(ASK_TOOL) => Some(SessionState::Blocked),
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "ElicitationResult" => {
            Some(SessionState::Working)
        }
        "Stop" => Some(SessionState::Done),
        _ => None,
    }
}

/// Builds the line the hook sends for one notice: `input` is the JSON Claude
/// Code sends on the hook's standard input, `tab_var` the value of
/// [`TAB_ID_VAR`]. The line is a [`StateMessage`] in JSON, then `\n`.
///
/// `None` when `input` is not JSON, has no `hook_event_name`, names an event
/// [`state_for`] ignores, or when `tab_var` is not a tab id.
pub fn hook_message(input: &[u8], tab_var: Option<&OsStr>) -> Option<Vec<u8>> {
    let tab = tab_var.and_then(parse_tab_id)?;
    let notice: serde_json::Value = serde_json::from_slice(input).ok()?;
    let event = notice.get("hook_event_name")?.as_str()?;
    let tool = notice.get("tool_name").and_then(serde_json::Value::as_str);
    let state = state_for(event, tool)?;
    let mut line = serde_json::to_vec(&StateMessage { tab, state }).ok()?;
    line.push(b'\n');
    Some(line)
}

/// Reads one message the app received: `None` when it holds more than
/// [`MESSAGE_LIMIT`] bytes, is not one JSON object with exactly a valid `tab`
/// and a known `state`, or holds anything after it but whitespace.
pub fn parse_message(bytes: &[u8]) -> Option<StateMessage> {
    if bytes.len() > MESSAGE_LIMIT {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// Runs the app's executable as the state hook: reads the notice on the
/// standard input and sends the state it means for the tab named by
/// [`TAB_ID_VAR`] to the running app of the same build. On other systems than
/// Windows, sends nothing.
///
/// Never fails, never waits for the app and never prints: whatever happens,
/// `claude` goes on.
pub fn run_state_hook() {
    let mut input = Vec::new();
    if std::io::stdin()
        .take(HOOK_INPUT_LIMIT)
        .read_to_end(&mut input)
        .is_err()
    {
        return;
    }
    let Some(line) = hook_message(&input, std::env::var_os(TAB_ID_VAR).as_deref()) else {
        return;
    };
    #[cfg(windows)]
    if let Some(name) = windows::pipe_name(crate::session::IDENTIFIER) {
        let _ = windows::send(&name, &line);
    }
    #[cfg(not(windows))]
    let _ = line;
}

/// Starts, on a background thread, the server that receives the state hook's
/// messages and emits each valid one to the webview as [`SESSION_STATE_EVENT`];
/// invalid messages are dropped.
///
/// Does nothing on other systems than Windows, or when the server cannot be
/// created, for instance because another process already holds its pipe: the
/// app then runs without session states.
pub fn start_server<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let Some(name) = windows::pipe_name(crate::session::IDENTIFIER) else {
            return;
        };
        let Ok(server) = windows::Server::bind(&name) else {
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            server.serve(|bytes| {
                if let Some(message) = parse_message(&bytes) {
                    let _ = app.emit(SESSION_STATE_EVENT, message);
                }
            });
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_events_map_to_their_state() {
        use SessionState::*;
        let cases = [
            ("PermissionRequest", Some("Bash"), Some(Blocked)),
            ("PreToolUse", Some(ASK_TOOL), Some(Blocked)),
            ("Elicitation", None, Some(Blocked)),
            ("UserPromptSubmit", None, Some(Working)),
            ("PostToolUse", Some("Bash"), Some(Working)),
            ("PostToolUseFailure", Some("Bash"), Some(Working)),
            ("ElicitationResult", None, Some(Working)),
            ("Stop", None, Some(Done)),
            ("PreToolUse", Some("Bash"), None),
            ("PreToolUse", None, None),
            ("SessionStart", None, None),
            ("Notification", None, None),
            ("stop", None, None),
            ("", None, None),
        ];
        for (event, tool, expected) in cases {
            assert_eq!(state_for(event, tool), expected, "{event} {tool:?}");
        }
    }

    #[test]
    fn every_event_the_hook_runs_on_means_a_state() {
        for event in STATE_HOOK_EVENTS {
            assert!(state_for(event, Some("Bash")).is_some(), "{event}");
        }
    }

    /// Builds the JSON a hook receives for `event`, with `tool` as `tool_name`.
    fn notice(event: &str, tool: Option<&str>) -> Vec<u8> {
        let mut value = serde_json::json!({
            "session_id": "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f",
            "cwd": "/projects/example",
            "hook_event_name": event,
        });
        if let Some(tool) = tool {
            value["tool_name"] = tool.into();
        }
        value.to_string().into_bytes()
    }

    #[test]
    fn a_notice_becomes_one_json_line() {
        let line = hook_message(&notice("PreToolUse", Some(ASK_TOOL)), Some(OsStr::new("7")));
        assert_eq!(line.unwrap(), b"{\"tab\":7,\"state\":\"blocked\"}\n");
        let line = hook_message(&notice("Stop", None), Some(OsStr::new("12")));
        assert_eq!(line.unwrap(), b"{\"tab\":12,\"state\":\"done\"}\n");
    }

    #[test]
    fn an_unusable_notice_sends_nothing() {
        let cases: [(&[u8], Option<&str>); 7] = [
            (b"not json", Some("7")),
            (b"{}", Some("7")),
            (br#"{"hook_event_name": 3}"#, Some("7")),
            (&notice("SessionStart", None), Some("7")),
            (&notice("Stop", None), None),
            (&notice("Stop", None), Some("0")),
            (&notice("Stop", None), Some("../7")),
        ];
        for (input, tab) in cases {
            assert_eq!(hook_message(input, tab.map(OsStr::new)), None);
        }
    }

    #[test]
    fn a_hook_line_reads_back_as_its_message() {
        let line = hook_message(&notice("UserPromptSubmit", None), Some(OsStr::new("4"))).unwrap();
        assert_eq!(
            parse_message(&line),
            Some(StateMessage {
                tab: NonZeroU32::new(4).unwrap(),
                state: SessionState::Working
            })
        );
    }

    #[test]
    fn a_malformed_message_is_dropped() {
        let long = format!(
            "{{\"tab\":1,\"state\":\"done\"}}{}",
            " ".repeat(MESSAGE_LIMIT)
        );
        for bad in [
            "",
            "not json",
            r#"{"tab":0,"state":"done"}"#,
            r#"{"tab":-1,"state":"done"}"#,
            r#"{"tab":4294967296,"state":"done"}"#,
            r#"{"tab":"1","state":"done"}"#,
            r#"{"tab":1,"state":"Done"}"#,
            r#"{"tab":1,"state":"sleeping"}"#,
            r#"{"tab":1}"#,
            r#"{"tab":1,"state":"done","extra":true}"#,
            "{\"tab\":1,\"state\":\"done\"}\n{\"tab\":2,\"state\":\"done\"}\n",
            &long,
        ] {
            assert_eq!(parse_message(bad.as_bytes()), None, "{bad:?}");
        }
    }

    #[test]
    fn the_webview_payload_is_tab_and_state() {
        let message = StateMessage {
            tab: NonZeroU32::new(3).unwrap(),
            state: SessionState::Blocked,
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({ "tab": 3, "state": "blocked" })
        );
    }
}
