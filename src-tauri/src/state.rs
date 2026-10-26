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
pub const STATE_HOOK_EVENTS: [&str; 9] = [
    "PermissionRequest",
    "Elicitation",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "ElicitationResult",
    "Stop",
    "SubagentStop",
    "StopFailure",
];

/// The tool whose `PreToolUse` event means the session waits for an answer;
/// the state hook runs on `PreToolUse` with this tool name as matcher.
pub const ASK_TOOL: &str = "AskUserQuestion";

/// The most bytes the hook reads from its standard input.
const HOOK_INPUT_LIMIT: u64 = 1 << 20;

/// The most bytes a state message may hold, final newline included. A longer
/// message is dropped.
pub const MESSAGE_LIMIT: usize = 256;

/// The most bytes an agent id may hold.
pub const AGENT_ID_LIMIT: usize = 64;

/// What a tab's session is doing, as told by its hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    /// Waits for the user: a permission, a question or an elicitation.
    Blocked,
    /// The user sent a prompt: every wait of the session is over, and it works
    /// on the prompt.
    Prompted,
    /// Works on a prompt.
    Working,
    /// Has finished answering.
    Done,
    /// Has finished answering, while background tasks of the session still run.
    Background,
    /// A subagent ended, and no background task of the session runs anymore.
    Settled,
    /// Its turn ended on an API error.
    Failed,
}

/// The id of the subagent a hook event comes from: 1 to [`AGENT_ID_LIMIT`]
/// ASCII letters, digits, `-` or `_`. Any other text is refused, when read
/// from JSON as well.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct AgentId(String);

impl TryFrom<String> for AgentId {
    type Error = &'static str;

    /// Accepts `id` when it is a valid agent id; refuses it otherwise.
    fn try_from(id: String) -> Result<Self, Self::Error> {
        let valid = !id.is_empty()
            && id.len() <= AGENT_ID_LIMIT
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        if valid {
            Ok(Self(id))
        } else {
            Err("not an agent id")
        }
    }
}

/// One state message: the tab id, the state of its session and, for an event
/// of a subagent, its id. Sent by the hook as one JSON line,
/// `{"tab":3,"state":"blocked","agent":"a1b2"}` (no `agent` for the main
/// conversation), and emitted to the webview in the same form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateMessage {
    /// The tab id, from 1.
    pub tab: NonZeroU32,
    /// The state of the tab's session.
    pub state: SessionState,
    /// The subagent the event comes from; `None` for the main conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentId>,
}

/// Returns the state a hook event means: `event` is its `hook_event_name`,
/// `tool` its `tool_name` when it has one, `background_tasks` the number of
/// entries of its `background_tasks`, 0 when it has none. `None` for any event
/// that tells nothing about the state, and for a `SubagentStop` while
/// background tasks still run.
pub fn state_for(event: &str, tool: Option<&str>, background_tasks: usize) -> Option<SessionState> {
    match event {
        "PermissionRequest" | "Elicitation" => Some(SessionState::Blocked),
        "PreToolUse" if tool == Some(ASK_TOOL) => Some(SessionState::Blocked),
        "UserPromptSubmit" => Some(SessionState::Prompted),
        "PostToolUse" | "PostToolUseFailure" | "ElicitationResult" => Some(SessionState::Working),
        "Stop" if background_tasks > 0 => Some(SessionState::Background),
        "Stop" => Some(SessionState::Done),
        "SubagentStop" if background_tasks == 0 => Some(SessionState::Settled),
        "StopFailure" => Some(SessionState::Failed),
        _ => None,
    }
}

/// Builds the line the hook sends for one notice: `input` is the JSON Claude
/// Code sends on the hook's standard input, `tab_var` the value of
/// [`TAB_ID_VAR`]. The line is a [`StateMessage`] in JSON, then `\n`; its
/// `agent` is the input's `agent_id`, absent when the input has none. A
/// `background_tasks` that is absent or not an array counts as empty.
///
/// `None` when `input` is not JSON, has no `hook_event_name`, names an event
/// [`state_for`] ignores, has an `agent_id` that is not an [`AgentId`], or
/// when `tab_var` is not a tab id.
pub fn hook_message(input: &[u8], tab_var: Option<&OsStr>) -> Option<Vec<u8>> {
    let tab = tab_var.and_then(parse_tab_id)?;
    let notice: serde_json::Value = serde_json::from_slice(input).ok()?;
    let event = notice.get("hook_event_name")?.as_str()?;
    let tool = notice.get("tool_name").and_then(serde_json::Value::as_str);
    let background_tasks = notice
        .get("background_tasks")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let state = state_for(event, tool, background_tasks)?;
    let agent = match notice.get("agent_id") {
        None => None,
        Some(id) => Some(AgentId::try_from(id.as_str()?.to_owned()).ok()?),
    };
    let mut line = serde_json::to_vec(&StateMessage { tab, state, agent }).ok()?;
    line.push(b'\n');
    Some(line)
}

/// Reads one message the app received: `None` when it holds more than
/// [`MESSAGE_LIMIT`] bytes, is not one JSON object with a valid `tab`, a known
/// `state` and maybe a valid `agent`, and nothing else, or holds anything after
/// it but whitespace.
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
            ("UserPromptSubmit", None, Some(Prompted)),
            ("PostToolUse", Some("Bash"), Some(Working)),
            ("PostToolUseFailure", Some("Bash"), Some(Working)),
            ("ElicitationResult", None, Some(Working)),
            ("Stop", None, Some(Done)),
            ("StopFailure", None, Some(Failed)),
            ("PreToolUse", Some("Bash"), None),
            ("PreToolUse", None, None),
            ("SessionStart", None, None),
            ("Notification", None, None),
            ("stop", None, None),
            ("", None, None),
        ];
        for (event, tool, expected) in cases {
            assert_eq!(state_for(event, tool, 0), expected, "{event} {tool:?}");
        }
    }

    #[test]
    fn stop_events_depend_on_background_tasks() {
        use SessionState::*;
        let cases = [
            ("Stop", 0, Some(Done)),
            ("Stop", 2, Some(Background)),
            ("SubagentStop", 0, Some(Settled)),
            ("SubagentStop", 1, None),
            ("StopFailure", 0, Some(Failed)),
            ("StopFailure", 1, Some(Failed)),
        ];
        for (event, tasks, expected) in cases {
            assert_eq!(state_for(event, None, tasks), expected, "{event} {tasks}");
        }
    }

    #[test]
    fn every_event_the_hook_runs_on_means_a_state() {
        for event in STATE_HOOK_EVENTS {
            assert!(state_for(event, Some("Bash"), 0).is_some(), "{event}");
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

    /// Builds the JSON a hook receives for `event`, with `tasks` as `background_tasks`.
    fn tasks_notice(event: &str, tasks: serde_json::Value) -> Vec<u8> {
        let mut value: serde_json::Value = serde_json::from_slice(&notice(event, None)).unwrap();
        value["background_tasks"] = tasks;
        value.to_string().into_bytes()
    }

    #[test]
    fn a_stop_notice_reads_its_background_tasks() {
        let task = serde_json::json!([{ "id": "b1", "type": "shell", "status": "running" }]);
        let send = |input: Vec<u8>| hook_message(&input, Some(OsStr::new("3")));
        let line = |state: &str| Some(format!("{{\"tab\":3,\"state\":\"{state}\"}}\n").into_bytes());
        let empty = serde_json::json!([]);
        assert_eq!(send(tasks_notice("Stop", task.clone())), line("background"));
        assert_eq!(send(tasks_notice("Stop", empty.clone())), line("done"));
        assert_eq!(send(notice("Stop", None)), line("done"));
        assert_eq!(send(tasks_notice("Stop", serde_json::json!({ "id": "b1" }))), line("done"));
        assert_eq!(send(tasks_notice("Stop", serde_json::json!(null))), line("done"));
        assert_eq!(send(tasks_notice("SubagentStop", empty)), line("settled"));
        assert_eq!(send(notice("SubagentStop", None)), line("settled"));
        assert_eq!(send(tasks_notice("SubagentStop", task.clone())), None);
        assert_eq!(send(tasks_notice("StopFailure", task)), line("failed"));
    }

    #[test]
    fn background_tasks_that_are_not_an_array_count_as_none() {
        let send = |input: Vec<u8>| hook_message(&input, Some(OsStr::new("3")));
        let line = |state: &str| Some(format!("{{\"tab\":3,\"state\":\"{state}\"}}\n").into_bytes());
        for tasks in [serde_json::json!("b1"), serde_json::json!(2), serde_json::json!(true)] {
            assert_eq!(send(tasks_notice("Stop", tasks.clone())), line("done"), "{tasks}");
            assert_eq!(send(tasks_notice("SubagentStop", tasks.clone())), line("settled"), "{tasks}");
        }
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
                state: SessionState::Prompted,
                agent: None,
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
            agent: None,
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({ "tab": 3, "state": "blocked" })
        );
    }

    /// Builds the JSON a subagent's hook receives for `event`, with `agent_id` set to `agent`.
    fn agent_notice(event: &str, agent: serde_json::Value) -> Vec<u8> {
        let mut value: serde_json::Value = serde_json::from_slice(&notice(event, None)).unwrap();
        value["agent_id"] = agent;
        value["agent_type"] = "general-purpose".into();
        value.to_string().into_bytes()
    }

    #[test]
    fn a_subagent_notice_carries_its_agent_id() {
        let line = hook_message(
            &agent_notice("PostToolUse", "a1b2-c3_D4".into()),
            Some(OsStr::new("5")),
        );
        assert_eq!(
            line.unwrap(),
            b"{\"tab\":5,\"state\":\"working\",\"agent\":\"a1b2-c3_D4\"}\n"
        );
    }

    #[test]
    fn a_notice_with_an_invalid_agent_id_sends_nothing() {
        let long = "a".repeat(AGENT_ID_LIMIT + 1);
        for agent in [
            serde_json::json!(""),
            serde_json::json!("a b"),
            serde_json::json!("a\"b"),
            serde_json::json!("agent/1"),
            serde_json::json!("a.b"),
            serde_json::json!("é"),
            serde_json::json!(long),
            serde_json::json!(3),
            serde_json::json!(null),
        ] {
            let input = agent_notice("PostToolUse", agent.clone());
            assert_eq!(hook_message(&input, Some(OsStr::new("5"))), None, "{agent}");
        }
    }

    #[test]
    fn the_longest_message_fits_the_limit() {
        let message = StateMessage {
            tab: NonZeroU32::MAX,
            state: SessionState::Background,
            agent: Some(AgentId::try_from("a".repeat(AGENT_ID_LIMIT)).unwrap()),
        };
        let mut line = serde_json::to_vec(&message).unwrap();
        line.push(b'\n');
        assert!(line.len() <= MESSAGE_LIMIT, "{} bytes", line.len());
        assert_eq!(parse_message(&line), Some(message));
    }

    #[test]
    fn a_message_reads_with_or_without_agent() {
        assert_eq!(
            parse_message(br#"{"tab":2,"state":"blocked","agent":"x-1_Y"}"#),
            Some(StateMessage {
                tab: NonZeroU32::new(2).unwrap(),
                state: SessionState::Blocked,
                agent: Some(AgentId::try_from("x-1_Y".to_owned()).unwrap()),
            })
        );
        assert_eq!(
            parse_message(br#"{"tab":2,"state":"prompted"}"#),
            Some(StateMessage {
                tab: NonZeroU32::new(2).unwrap(),
                state: SessionState::Prompted,
                agent: None,
            })
        );
    }

    #[test]
    fn a_message_with_an_invalid_agent_is_dropped() {
        let long = format!(
            "{{\"tab\":1,\"state\":\"done\",\"agent\":\"{}\"}}",
            "a".repeat(AGENT_ID_LIMIT + 1)
        );
        for bad in [
            r#"{"tab":1,"state":"done","agent":""}"#,
            r#"{"tab":1,"state":"done","agent":"a b"}"#,
            r#"{"tab":1,"state":"done","agent":"<x>"}"#,
            r#"{"tab":1,"state":"done","agent":"a.b"}"#,
            r#"{"tab":1,"state":"done","agent":3}"#,
            &long,
        ] {
            assert_eq!(parse_message(bad.as_bytes()), None, "{bad:?}");
        }
    }

    #[test]
    fn a_null_agent_reads_as_the_main_conversation() {
        assert_eq!(
            parse_message(br#"{"tab":2,"state":"working","agent":null}"#),
            Some(StateMessage {
                tab: NonZeroU32::new(2).unwrap(),
                state: SessionState::Working,
                agent: None,
            })
        );
    }

    #[test]
    fn the_webview_payload_carries_the_agent_when_present() {
        let message = StateMessage {
            tab: NonZeroU32::new(3).unwrap(),
            state: SessionState::Working,
            agent: Some(AgentId::try_from("a1".to_owned()).unwrap()),
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({ "tab": 3, "state": "working", "agent": "a1" })
        );
    }
}
