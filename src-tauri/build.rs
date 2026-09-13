// Tauri build script.
//
// The AppManifest below is REQUIRED for the capability system to recognize this
// app's own `#[tauri::command]`s.
//
// Tauri v2 does not auto-discover app commands: without an explicit manifest,
// `capabilities/default.json` fails to build with
//
//     Permission allow-sidecar-port not found, expected one of core:default, ...
//
// because no `allow-*` permission exists for the app. Declaring the names here
// generates `allow-<name>` / `deny-<name>` for each one (see tauri-build's
// `AppManifest::commands`).
//
// KEEP THIS LIST IN SYNC WITH `invoke_handler` IN src/lib.rs. A command missing
// here has no permission identifier, so granting it in a capability is a build
// error - which is the safe direction to fail in. (Phase 0 did not need this
// because `capabilities/default.json` granted no app commands; the harness
// window's capability grants none by design, and the main window now grants
// exactly these six.)

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                // Phase 0: publish the sidecar's handshake port to the UI.
                "sidecar_port",
                // Phase 1: proxy the three control routes. The frontend never
                // talks HTTP to the sidecar directly (no CORS, capability-gated).
                "harness_status",
                "harness_start",
                "harness_stop",
                // Phase 1: the harness window's lifecycle. Commands, so they are
                // attributable to the MAIN window only - the remote harness window
                // can call nothing.
                "open_harness_window",
                "close_harness_window",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
