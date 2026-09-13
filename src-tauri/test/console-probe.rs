// Console-attachment probe. TEST-ONLY - not part of the shipped launcher.
//
// WHY THIS EXISTS: a stray black `node.exe` console window kept appearing
// alongside the launcher, and there was no objective way to tell which spawn
// site was at fault. This helper answers it directly.
//
// It is built as a GUI-subsystem binary, so it has NO console of its own. That
// is what makes the probe meaningful: `AttachConsole(pid)` succeeds only if the
// target really has a console. A console-subsystem probe could never tell the
// difference, because Windows would give the probe itself one.
//
// USAGE
//   rustc -O -o console_probe.exe src-tauri/test/console_probe.rs
//   console_probe.exe <pid> <out-file>
//
// The verdict is written to <out-file>, NOT stdout: `FreeConsole()` detaches the
// process from the caller's terminal, so anything printed afterwards can be lost
// (observed as an empty result during development).
//
// Verdicts:
//   console                  the target has a console window
//   none(err=N)              the target exists and has NO console - the healthy
//                            case, and what CREATE_NO_WINDOW produces
//   no-such-process(err=N)   the target does not exist (or already exited)
//
// `src-tauri/test/console-check.ps1` drives it against real children.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn FreeConsole() -> i32;
        fn GetConsoleWindow() -> *mut c_void;
        fn GetLastError() -> u32;
    }

    let pid: u32 = match std::env::args().nth(1).and_then(|a| a.parse().ok()) {
        Some(pid) => pid,
        None => std::process::exit(2),
    };
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "console-probe.out".to_owned());

    let verdict = {
        // Ask first whether the target exists. Without this, ERROR_INVALID_HANDLE
        // is ambiguous, and an earlier version of this probe reported healthy
        // console-less GUI processes as "no-such-process" - which sent me
        // hunting for a crash that had never happened.
        let exists = process_exists(pid);

        // SAFETY: AttachConsole takes only a pid; no shared state is touched.
        unsafe {
            FreeConsole();
            if AttachConsole(pid) == 0 {
                let code = GetLastError();
                if exists {
                    // Exists, no console. Both ERROR_GEN_FAILURE (31) and
                    // ERROR_INVALID_HANDLE (6) occur here depending on how the
                    // process was created; the existence check disambiguates.
                    format!("none(err={code})")
                } else {
                    format!("no-such-process(err={code})")
                }
            } else {
                let has_console = !GetConsoleWindow().is_null();
                FreeConsole();
                if has_console { "console".to_owned() } else { "none".to_owned() }
            }
        }
    };

    let _ = std::fs::write(out_path, verdict);
}

/// True when a process with `pid` exists and is still running.
#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn GetLastError() -> u32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    // SAFETY: every opened handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // A pid that does not exist gives ERROR_INVALID_PARAMETER. Anything
            // else (e.g. access denied) means it is there but not ours to query.
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn main() {
    // Console allocation is a Windows concern; the spawn flags are Windows-only.
    print!("not-applicable");
}
