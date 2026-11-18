const COMMANDS: &[&str] = &["link_list_serial", "link_open_serial", "link_open_tcp", "link_write", "link_close"];

fn main() {
    // Declaring the app's commands makes each one need an explicit capability grant
    // (capabilities/default.json), so only the main window can reach serial ports and sockets.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
