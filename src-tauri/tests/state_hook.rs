//! Runs the app's executable as the state hook, as Claude Code runs it.
#![cfg(windows)]

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// A tab id no tab of a running app holds, so a message that reaches one is ignored.
const UNUSED_TAB: &str = "4294967295";

/// Runs `cloitre state-hook` with `input` on its standard input and the tab id
/// variable set to `tab`, or removed when `None`, and returns what it printed,
/// its exit status and how long it ran.
fn run_hook(input: &[u8], tab: Option<&str>) -> (Output, Duration) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cloitre"));
    command
        .arg("state-hook")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match tab {
        Some(tab) => command.env("CLOITRE_TAB_ID", tab),
        None => command.env_remove("CLOITRE_TAB_ID"),
    };
    let start = Instant::now();
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    (output, start.elapsed())
}

/// Asserts the hook ended at once, successfully, without printing anything.
fn assert_silent_success((output, elapsed): (Output, Duration)) {
    assert!(output.status.success(), "{:?}", output.status);
    assert!(
        output.stdout.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.stderr.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
}

#[test]
fn the_hook_ends_silently_and_successfully_for_a_state_notice() {
    for event in [
        r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
        r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}"#,
        r#"{"hook_event_name":"Stop"}"#,
    ] {
        assert_silent_success(run_hook(event.as_bytes(), Some(UNUSED_TAB)));
    }
}

#[test]
fn the_hook_ends_silently_and_successfully_for_an_unusable_notice() {
    assert_silent_success(run_hook(b"not json", Some(UNUSED_TAB)));
    assert_silent_success(run_hook(b"", Some(UNUSED_TAB)));
    assert_silent_success(run_hook(br#"{"hook_event_name":"Stop"}"#, None));
    assert_silent_success(run_hook(
        br#"{"hook_event_name":"Stop"}"#,
        Some("not a tab"),
    ));
}

/// Runs `cloitre state-hook` with `input`, the tab id variable set to `tab` and
/// the log variable set to `log`, and returns what it printed, its exit status
/// and how long it ran.
fn run_logging_hook(input: &[u8], tab: &str, log: &std::path::Path) -> (Output, Duration) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cloitre"));
    command
        .arg("state-hook")
        .env("CLOITRE_TAB_ID", tab)
        .env("CLOITRE_STATE_LOG", log)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let start = Instant::now();
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    (output, start.elapsed())
}

#[test]
fn the_hook_appends_one_line_per_stop_notice_to_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("state.log");
    for event in [
        r#"{"hook_event_name":"Stop","background_tasks":[{"type":"shell","command":"pnpm dev"}]}"#,
        r#"{"hook_event_name":"PostToolUse","tool_name":"Bash"}"#,
        r#"{"hook_event_name":"SubagentStop","agent_id":"a1b2"}"#,
        "not json",
    ] {
        assert_silent_success(run_logging_hook(event.as_bytes(), UNUSED_TAB, &log));
    }
    let text = std::fs::read_to_string(&log).unwrap();
    let entries: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 2, "{text}");
    assert_eq!(entries[0]["event"], "Stop");
    assert_eq!(entries[0]["tab"], 4294967295u64);
    assert_eq!(entries[0]["background_tasks"][0]["command"], "pnpm dev");
    assert_eq!(entries[1]["event"], "SubagentStop");
    assert_eq!(entries[1]["agent"], "a1b2");
}

#[test]
fn the_hook_writes_no_log_for_a_notice_it_does_not_log() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("state.log");
    assert_silent_success(run_logging_hook(
        br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
        UNUSED_TAB,
        &log,
    ));
    assert!(!log.exists());
}

#[test]
fn the_hook_ends_silently_and_successfully_when_the_log_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("missing").join("state.log");
    assert_silent_success(run_logging_hook(
        br#"{"hook_event_name":"Stop"}"#,
        UNUSED_TAB,
        &log,
    ));
    assert!(!log.exists());
}
