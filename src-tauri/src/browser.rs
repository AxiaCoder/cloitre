//! Browser mode: opens a web page for a `claude` session, outside the
//! session's job, so the browser survives the tab.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use crate::launch::TAB_ID_VAR;

#[cfg(windows)]
mod windows;

/// Name of the variable Claude Code reads to find the program that opens a URL.
pub const BROWSER_VAR: &str = "BROWSER";

/// Exit code of a refused URL or of a browser that could not be started.
const FAILED: i32 = 1;

/// Returns the program a session gets as [`BROWSER_VAR`]: the app's own
/// executable on Windows, `None` elsewhere or when its path is unknown.
pub fn browser_program() -> Option<PathBuf> {
    if cfg!(windows) {
        env::current_exe().ok()
    } else {
        None
    }
}

/// Runs the browser mode when the process was started as one: on Windows only,
/// with exactly one argument and [`TAB_ID_VAR`] set, as Claude Code starts
/// `$BROWSER <url>` from a session.
///
/// Returns `None` when it is not the browser mode, else the exit code: the one
/// of `rundll32 url.dll,OpenURL <url>`, or 1 when the argument is not a web URL
/// (see [`web_url`]) or the opener cannot be started. Must be checked after
/// the hook arguments, which also come alone with [`TAB_ID_VAR`] set.
pub fn run_browser_mode() -> Option<i32> {
    if !cfg!(windows) {
        return None;
    }
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let argument = requested(&args, env::var_os(TAB_ID_VAR).as_deref())?;
    Some(web_url(argument).map_or(FAILED, open))
}

/// Returns the argument of a browser call: the only one of `args` (program
/// excluded) when `tab`, the value of [`TAB_ID_VAR`], is set; `None` otherwise.
fn requested<'a>(args: &'a [OsString], tab: Option<&OsStr>) -> Option<&'a OsStr> {
    match (args, tab) {
        ([argument], Some(_)) => Some(argument),
        _ => None,
    }
}

/// Returns `argument` when it is a web URL: `http://` or `https://` (any case)
/// followed by a host, only printable ASCII, no space and no double quote.
/// Any other scheme, a path or an empty host gives `None`.
fn web_url(argument: &OsStr) -> Option<&str> {
    let url = argument.to_str()?;
    let rest = strip_prefix_ignore_case(url, "https://")
        .or_else(|| strip_prefix_ignore_case(url, "http://"))?;
    let safe = url
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && byte != b'"');
    let has_host = !rest.is_empty() && !rest.starts_with(['/', '\\']);
    (safe && has_host).then_some(url)
}

/// Returns `text` without `prefix` when it starts with it, ASCII case ignored.
fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// Opens `url` in the default browser outside the session's job and returns
/// the opener's exit code, or 1 when it cannot be started.
#[cfg(windows)]
fn open(url: &str) -> i32 {
    windows::open(url).unwrap_or(FAILED)
}

/// Opens nothing: the browser mode exists on Windows only. Returns 1.
#[cfg(not(windows))]
fn open(_url: &str) -> i32 {
    FAILED
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns `args` as owned arguments.
    fn args(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    /// Runs [`web_url`] on `text`.
    fn web(text: &str) -> Option<&str> {
        web_url(OsStr::new(text))
    }

    #[test]
    fn one_argument_with_a_tab_is_a_browser_call() {
        let given = args(&["https://example.com"]);
        assert_eq!(
            requested(&given, Some(OsStr::new("3"))),
            Some(OsStr::new("https://example.com"))
        );
    }

    #[test]
    fn without_a_tab_it_is_not_a_browser_call() {
        assert_eq!(requested(&args(&["https://example.com"]), None), None);
    }

    #[test]
    fn no_argument_or_several_are_not_a_browser_call() {
        let tab = Some(OsStr::new("3"));
        assert_eq!(requested(&args(&[]), tab), None);
        assert_eq!(requested(&args(&["https://a.example", "extra"]), tab), None);
    }

    #[test]
    fn http_and_https_urls_with_a_host_are_web_urls() {
        for url in [
            "http://example.com",
            "https://example.com/path?q=1&r=%20#top",
            "https://localhost:8080",
        ] {
            assert_eq!(web(url), Some(url));
        }
    }

    #[test]
    fn the_scheme_is_matched_in_any_case() {
        for url in ["HTTPS://example.com", "Http://example.com", "hTtPs://x"] {
            assert_eq!(web(url), Some(url));
        }
    }

    #[test]
    fn other_schemes_and_paths_are_refused() {
        for text in [
            "file:///C:/Windows/System32/calc.exe",
            "ftp://example.com",
            "javascript:alert(1)",
            r"C:\Windows\System32\calc.exe",
            "/usr/bin/env",
            "example.com",
            "",
            "http",
            "https:/example.com",
        ] {
            assert_eq!(web(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn an_empty_or_path_like_host_is_refused() {
        for text in [
            "http://",
            "https://",
            "http:///x",
            "https:///etc/passwd",
            r"https://\\server\share",
            r"http://\x",
        ] {
            assert_eq!(web(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn spaces_quotes_controls_and_non_ascii_are_refused() {
        for text in [
            "https://example.com/a b",
            "https://example.com/\"x\"",
            "https://example.com\" --flag",
            "https://example.com/\tx",
            "https://example.com/\nx",
            "https://exämple.com",
            " https://example.com",
            "https://example.com ",
        ] {
            assert_eq!(web(text), None, "{text:?} was accepted");
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_argument_that_is_not_unicode_is_refused() {
        use std::os::windows::ffi::OsStringExt;

        let mut units: Vec<u16> = "https://example.com/".encode_utf16().collect();
        units.push(0xD800);
        assert_eq!(web_url(&OsString::from_wide(&units)), None);
    }

    #[test]
    fn the_browser_program_exists_on_windows_only() {
        assert_eq!(browser_program().is_some(), cfg!(windows));
    }
}
