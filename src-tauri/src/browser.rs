//! Browser mode: opens a URL for a `claude` session. A web page is opened by
//! the app, outside every session's job, so the browser survives the tab.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use crate::launch::TAB_ID_VAR;

#[cfg(windows)]
mod windows;

/// Name of the variable Claude Code reads to find the program that opens a URL.
pub const BROWSER_VAR: &str = "BROWSER";

/// Exit code of a refused URL or of an opener that could not be started.
const FAILED: i32 = 1;

/// Exit code of a URL handed over to the app.
const SENT: i32 = 0;

/// Longest URL, in bytes, the browser mode hands over to the app; a longer
/// one is opened inside the session's job.
pub const URL_LIMIT: usize = 16 * 1024;

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
/// Returns `None` when it is not the browser mode, else the exit code. A web
/// URL (see [`web_url`]) is sent to the running app, 0 once sent; when the
/// app cannot be reached, or the URL is longer than [`URL_LIMIT`], it is
/// opened like a URL of another scheme (see [`other_url`]): by `rundll32
/// url.dll,OpenURL <url>` inside the session's job, with its exit code. Any
/// other argument, or an opener that cannot be started, gives 1. Must be
/// checked after the hook arguments, which also come alone with
/// [`TAB_ID_VAR`] set.
pub fn run_browser_mode() -> Option<i32> {
    if !cfg!(windows) {
        return None;
    }
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let argument = requested(&args, env::var_os(TAB_ID_VAR).as_deref())?;
    Some(match web_url(argument) {
        Some(url) if url.len() <= URL_LIMIT && send_to_app(url) => SENT,
        Some(url) => open_in_job(url),
        None => other_url(argument).map_or(FAILED, open_in_job),
    })
}

/// Starts the server through which sessions hand web URLs to the app, which
/// opens each one outside every session's job (see [`received_url`]). Does
/// nothing on other systems than Windows, or when the server cannot be
/// created: sessions then open URLs inside their own job.
pub fn start_server() {
    #[cfg(windows)]
    windows::start_server(crate::session::IDENTIFIER);
}

/// Returns the URL in `message`, a message received from a session, when it
/// is at most [`URL_LIMIT`] bytes of UTF-8 forming a web URL (see
/// [`web_url`]); `None` otherwise.
pub fn received_url(message: &[u8]) -> Option<&str> {
    if message.len() > URL_LIMIT {
        return None;
    }
    web_url(OsStr::new(std::str::from_utf8(message).ok()?))
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
    let has_host = !rest.is_empty() && !rest.starts_with(['/', '\\']);
    (is_safe(url) && has_host).then_some(url)
}

/// Returns `argument` when it is a URL of a scheme other than `http`, `https`
/// and `file` (any case), such as `vscode:` or `slack:`: a scheme as RFC 3986
/// writes it (a letter, then letters, digits, `+`, `-` or `.`) of at least two
/// characters, so a drive letter is not one, then `:`, the whole only
/// printable ASCII, no space and no double quote. `None` otherwise.
fn other_url(argument: &OsStr) -> Option<&str> {
    let url = argument.to_str()?;
    let (scheme, _) = url.split_once(':')?;
    let mut characters = scheme.bytes();
    let well_formed = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && characters.all(|byte| byte.is_ascii_alphanumeric() || b"+-.".contains(&byte));
    let excluded = ["http", "https", "file"]
        .iter()
        .any(|name| scheme.eq_ignore_ascii_case(name));
    (well_formed && scheme.len() >= 2 && !excluded && is_safe(url)).then_some(url)
}

/// Tells whether `url` holds only printable ASCII other than the double quote,
/// so no space either.
fn is_safe(url: &str) -> bool {
    url.bytes()
        .all(|byte| byte.is_ascii_graphic() && byte != b'"')
}

/// Returns `text` without `prefix` when it starts with it, ASCII case ignored.
fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// Hands the web URL `url` to the running app; tells whether it was sent.
#[cfg(windows)]
fn send_to_app(url: &str) -> bool {
    windows::send_to_app(crate::session::IDENTIFIER, url).is_ok()
}

/// Sends nothing: the browser mode exists on Windows only. Returns `false`.
#[cfg(not(windows))]
fn send_to_app(_url: &str) -> bool {
    false
}

/// Opens `url` inside the caller's job and returns the opener's exit code, or
/// 1 when it cannot be started.
#[cfg(windows)]
fn open_in_job(url: &str) -> i32 {
    windows::open_in_job(url).unwrap_or(FAILED)
}

/// Opens nothing: the browser mode exists on Windows only. Returns 1.
#[cfg(not(windows))]
fn open_in_job(_url: &str) -> i32 {
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

    /// Runs [`other_url`] on `text`.
    fn other(text: &str) -> Option<&str> {
        other_url(OsStr::new(text))
    }

    #[test]
    fn a_received_web_url_up_to_the_limit_is_accepted() {
        let url = format!("https://example.com/{}", "a".repeat(URL_LIMIT - 20));
        assert_eq!(url.len(), URL_LIMIT);
        assert_eq!(received_url(url.as_bytes()), Some(url.as_str()));
    }

    #[test]
    fn a_received_url_one_byte_over_the_limit_is_refused() {
        let url = format!("https://example.com/{}", "a".repeat(URL_LIMIT - 19));
        assert_eq!(url.len(), URL_LIMIT + 1);
        assert_eq!(received_url(url.as_bytes()), None);
    }

    #[test]
    fn a_received_message_that_is_not_utf8_is_refused() {
        assert_eq!(received_url(b"https://example.com/\xff"), None);
        assert_eq!(received_url(b"https://example.com/\xc3"), None);
    }

    #[test]
    fn a_received_message_that_is_not_a_web_url_is_refused() {
        for message in [
            "vscode://file/x",
            "file:///C:/x",
            "http:///x",
            "https://example.com/a b",
            "https://example.com\" --flag",
            "",
        ] {
            assert_eq!(received_url(message.as_bytes()), None, "{message:?}");
        }
    }

    #[test]
    fn urls_of_other_schemes_are_accepted() {
        for url in [
            "vscode://file/C:/project/main.rs:3",
            "jetbrains://idea/navigate/reference?project=x",
            "slack:open",
            "ms-settings:display",
            "x-web+search.v2:q",
            "VSCODE://file/x",
        ] {
            assert_eq!(other(url), Some(url), "{url:?} was refused");
        }
    }

    #[test]
    fn web_and_file_schemes_are_not_other_urls() {
        for text in [
            "file:///C:/Windows/System32/calc.exe",
            "FILE:///C:/x",
            "File:x",
            "http:///x",
            "https:/x",
            "HTTP://example.com",
            "https://example.com",
        ] {
            assert_eq!(other(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn a_drive_letter_or_a_one_character_scheme_is_not_a_scheme() {
        for text in [r"C:\x", "C:/x", "c:x", "a:b"] {
            assert_eq!(other(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn malformed_schemes_are_refused() {
        for text in [
            "1x:y",
            "+x:y",
            "x_y:z",
            "x y:z",
            ":x",
            "vscode",
            "",
            r"\\server\share",
            "/usr/bin/env",
        ] {
            assert_eq!(other(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn other_urls_with_spaces_quotes_or_non_ascii_are_refused() {
        for text in [
            "vscode://file/a b",
            "vscode://file/\"x\"",
            "vscode://x\" --flag",
            "vscode://file/\tx",
            "vscode://fïle",
            "vscode://x ",
        ] {
            assert_eq!(other(text), None, "{text:?} was accepted");
        }
    }

    #[test]
    fn the_browser_program_exists_on_windows_only() {
        assert_eq!(browser_program().is_some(), cfg!(windows));
    }
}
