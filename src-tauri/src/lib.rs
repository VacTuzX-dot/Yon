mod app;
pub mod client;
pub mod discovery;
pub mod identity;
pub mod link;
pub mod platform;
pub mod protocol;
pub mod sanitize;
pub mod server;
pub mod settings;
pub mod transfer;
mod update;

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

    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch (Windows "Send to") hands its
    // arguments to the running instance instead of starting another one.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        app::show_main(app);
        app::open_paths(app, app::paths_from_args(&args, std::path::Path::new(&cwd)));
    }));
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = app::setup(app.handle())?;
            let show_in_dock = state.settings_show_in_dock();
            app.manage(state);
            app::setup_tray(app.handle())?;
            app::start_updates(app.handle());
            if !show_in_dock {
                app::apply_dock_visibility(app.handle(), false);
            }
            // First launch from "Send to": files arrive as arguments.
            let args: Vec<String> = std::env::args().collect();
            if let Ok(cwd) = std::env::current_dir() {
                app::open_paths(app.handle(), app::paths_from_args(&args, &cwd));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drop) = event {
                // WHY: handled here so dropped paths stay in Rust; the UI
                // only learns where they landed (CSS px) and gets an id.
                // WHY: despite the `PhysicalPosition` type, wry reports macOS
                // (AppKit points) and Linux (GTK) drops in CSS px already;
                // only Windows (ScreenToClient) is in device pixels. Dividing
                // on macOS halved y on Retina and lit up the wrong device.
                let scale = if cfg!(windows) {
                    window.scale_factor().unwrap_or(1.0)
                } else {
                    1.0
                };
                let css = |p: &tauri::PhysicalPosition<f64>| (p.x / scale, p.y / scale);
                let app = window.app_handle();
                match drop {
                    tauri::DragDropEvent::Enter { paths, position } => {
                        let files = paths.iter().filter(|p| p.is_file()).count();
                        app::drop_hover(app, Some(css(position)), Some(files));
                    }
                    tauri::DragDropEvent::Over { position } => {
                        app::drop_hover(app, Some(css(position)), None);
                    }
                    tauri::DragDropEvent::Drop { paths, position } => {
                        app::drop_hover(app, None, None);
                        app::dropped(app, paths.clone(), css(position));
                    }
                    _ => app::drop_hover(app, None, None),
                }
                return;
            }
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
            app::take_shared,
            app::set_show_in_dock,
            app::pair_phone,
            app::unpair_phone,
            app::cancel_pairing,
            app::check_update,
            app::install_update,
            app::set_check_updates,
            app::set_remote,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        match _event {
            // Clicking the Dock icon brings the hidden window back.
            tauri::RunEvent::Reopen { .. } => app::show_main(_app),
            // Finder "Open With → Yon" or files dropped on the Dock icon.
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .collect();
                app::open_paths(_app, paths);
            }
            _ => {}
        }
    });
}
