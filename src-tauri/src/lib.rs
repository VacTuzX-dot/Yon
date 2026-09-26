mod app;
pub mod client;
pub mod discovery;
pub mod identity;
pub mod platform;
pub mod protocol;
pub mod sanitize;
pub mod server;
pub mod settings;
pub mod transfer;

use std::time::{Duration, Instant};

/// Rate-limits progress events (~10/s) so the UI isn't flooded per chunk.
pub(crate) struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    const EVERY: Duration = Duration::from_millis(100);

    pub(crate) fn new() -> Self {
        Self { last: None }
    }

    pub(crate) fn ready(&mut self, force: bool) -> bool {
        let now = Instant::now();
        if force || self.last.is_none_or(|l| now - l >= Self::EVERY) {
            self.last = Some(now);
            true
        } else {
            false
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let state = app::setup(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::get_state,
            app::pick_files,
            app::clear_selection,
            app::send,
            app::cancel_send,
            app::respond,
            app::cancel_receive,
            app::reveal,
            app::update_settings,
            app::pick_save_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
