#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Supervisor mode for detached flow commands: no window, no app.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = mdium_lib::flow_supervise(&args) {
        std::process::exit(code);
    }
    mdium_lib::run()
}
