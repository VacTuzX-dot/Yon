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
    use tauri::Manager;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = app::setup(app.handle())?;
            app.manage(state);
            app::setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // WHY: keep Yon running (and able to receive) when the window is
            // closed — ⌘W / red button on macOS, X on Windows if enabled.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let hide = window
                    .try_state::<app::AppState>()
                    .map(|s| s.hide_on_close())
                    .unwrap_or(false);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
            app::set_close_to_tray,
            app::untrust,
            app::forget_received,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // Clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            app::show_main(_app);
        }
    });
}
