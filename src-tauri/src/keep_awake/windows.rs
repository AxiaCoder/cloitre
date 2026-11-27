use std::sync::OnceLock;
use std::sync::mpsc::{self, Sender};
use std::thread;

use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, EXECUTION_STATE, SetThreadExecutionState,
};

/// A state for the keep-awake thread, with the channel its answer goes back on.
type Request = (bool, Sender<EXECUTION_STATE>);

/// The sender of the thread that holds the keep-awake request, once started.
static REQUESTS: OnceLock<Sender<Request>> = OnceLock::new();

/// Hands `on` to the keep-awake thread, starting it on the first call, and
/// waits until the thread has applied it.
///
/// `SetThreadExecutionState` holds its request per thread: applying every
/// state on the same thread is what lets a later "off" remove an earlier "on".
/// Returns the keep-awake thread's previous execution state, or `None` when
/// Windows refused the state or the thread did not answer.
pub fn set(on: bool) -> Option<EXECUTION_STATE> {
    let requests = REQUESTS.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Request>();
        thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                for (on, answer) in receiver {
                    let _ = answer.send(apply(on));
                }
            })
            .expect("failed to start the keep-awake thread");
        sender
    });
    let (answer, answers) = mpsc::channel();
    requests.send((on, answer)).ok()?;
    answers.recv().ok().filter(|&previous| previous != 0)
}

/// Returns the execution state that keeps the system awake (`on`) or clears
/// the request: never the display flag, so the screen may still turn off.
fn execution_state(on: bool) -> EXECUTION_STATE {
    if on {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    }
}

/// Applies `on` to the calling thread, and returns the thread's previous
/// execution state, or 0 when Windows refused it.
fn apply(on: bool) -> EXECUTION_STATE {
    // SAFETY: SetThreadExecutionState takes flags by value and touches no memory of ours.
    unsafe { SetThreadExecutionState(execution_state(on)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Power::ES_DISPLAY_REQUIRED;

    #[test]
    fn on_asks_for_the_system_and_never_the_display() {
        assert_eq!(execution_state(true), ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        assert_eq!(execution_state(true) & ES_DISPLAY_REQUIRED, 0);
    }

    #[test]
    fn off_clears_the_request() {
        assert_eq!(execution_state(false), ES_CONTINUOUS);
    }

    #[test]
    fn windows_accepts_on_then_off_and_reports_the_previous_state() {
        assert_ne!(apply(true), 0);
        let previous = apply(false);
        assert_ne!(previous, 0);
        assert_eq!(previous & ES_SYSTEM_REQUIRED, ES_SYSTEM_REQUIRED);
    }

    #[test]
    fn set_applies_on_and_off_on_the_same_thread() {
        set(true).expect("Windows refused on");
        let after_on = set(false).expect("Windows refused off");
        assert_eq!(after_on & ES_SYSTEM_REQUIRED, ES_SYSTEM_REQUIRED);
        let after_off = set(false).expect("Windows refused the second off");
        assert_eq!(after_off & ES_SYSTEM_REQUIRED, 0);
    }
}
