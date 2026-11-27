#[cfg(windows)]
mod windows;

/// Keeps the system from sleeping (`on`) or lets it sleep again, for as long
/// as the app runs: the request ends with the process. The screen may still
/// turn off, and closing the lid or pressing the power button still puts the
/// computer to sleep.
///
/// On Windows the request is held by a dedicated thread, started on the first
/// call, so that a later call made from any thread replaces it. Does nothing
/// elsewhere. Returns at once, before the request is applied.
pub fn set(on: bool) {
    #[cfg(windows)]
    {
        windows::set(on);
    }
    #[cfg(not(windows))]
    {
        let _ = on;
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn does_nothing_outside_windows() {
        set(true);
        set(false);
    }
}
