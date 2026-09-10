// Prevents an additional console window on Windows in release builds.
// This attribute must stay at the very top of the file.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_dock_lib::run()
}
