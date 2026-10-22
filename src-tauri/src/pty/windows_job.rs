use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// Exit code given to the processes stopped by [`Job::terminate`].
const TERMINATED_EXIT_CODE: u32 = 1;

/// A Windows job object holding a session's process and every process it starts,
/// including those that open their own console.
///
/// Dropping it closes the job, which stops every process still in it. The
/// system closes the job the same way when the app ends, even abruptly.
pub struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle, valid from any thread; `Job`
// owns it alone and only passes it to thread-safe kernel calls.
unsafe impl Send for Job {}

impl Job {
    /// Creates a job that stops its processes when it closes, and puts process
    /// `pid` in it. The processes `pid` starts afterwards join the job too; those
    /// it started before do not.
    ///
    /// # Errors
    /// The system error of the call that failed, for instance when `pid` names
    /// no running process.
    pub fn assign(pid: u32) -> io::Result<Job> {
        let job = Job::create()?;
        job.add(pid)?;
        Ok(job)
    }

    /// Creates an empty, unnamed job that stops its processes when it closes.
    ///
    /// # Errors
    /// The system error of the call that failed.
    fn create() -> io::Result<Job> {
        // SAFETY: null attributes and name are allowed: default security, no name.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is the structure this information class expects, the
        // length given is its size, and it outlives the call.
        let set = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Puts process `pid` in the job.
    ///
    /// # Errors
    /// The system error when the process cannot be opened or assigned.
    fn add(&self, pid: u32) -> io::Result<()> {
        // SAFETY: plain call; a null result is handled below.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are open and owned here.
        let assigned = unsafe { AssignProcessToJobObject(self.0, process) };
        let error = io::Error::last_os_error();
        // SAFETY: `process` is open and closed only here.
        unsafe { CloseHandle(process) };
        if assigned == 0 { Err(error) } else { Ok(()) }
    }

    /// Stops every process in the job. Failures are ignored: the job also stops
    /// them when it is dropped.
    pub fn terminate(&self) {
        // SAFETY: `self.0` is an open job handle until drop.
        unsafe { TerminateJobObject(self.0, TERMINATED_EXIT_CODE) };
    }
}

impl Drop for Job {
    /// Closes the job handle, which stops every process still in the job.
    fn drop(&mut self) {
        // SAFETY: `self.0` is open and closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::core::BOOL;

    use super::*;

    /// Starts a process that waits about 30 seconds without output.
    fn long_process() -> Child {
        Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("ping starts")
    }

    /// Waits up to 5 seconds for `child` to end; tells whether it did.
    fn ends_soon(child: &mut Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if child.try_wait().expect("child can be polled").is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    fn assigned_process_is_in_the_job() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        let mut in_job: BOOL = 0;
        // SAFETY: both handles are open for the whole call.
        let checked = unsafe { IsProcessInJob(child.as_raw_handle(), job.0, &raw mut in_job) };
        assert_ne!(checked, 0);
        assert_ne!(in_job, 0);
        let _ = child.kill();
    }

    #[test]
    fn dropping_the_job_stops_its_process() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        drop(job);
        let ended = ends_soon(&mut child);
        let _ = child.kill();
        assert!(ended, "the process survived the job");
    }

    #[test]
    fn terminate_stops_its_process() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        job.terminate();
        let ended = ends_soon(&mut child);
        let _ = child.kill();
        assert!(ended, "the process survived terminate");
    }

    #[test]
    fn assigning_a_missing_process_fails() {
        assert!(Job::assign(0).is_err());
    }
}
