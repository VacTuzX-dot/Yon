//! Tauri shell: state, IPC commands and events.
//!
//! Trust boundary: the webview never sends a file-system path. Files and
//! folders are picked here in Rust; the UI only gets opaque ids plus names
//! and sizes to display.

use crate::client::{self, OutFile, SendOutcome, SendStatus, Target};
use crate::discovery::{Device, Discovery};
use crate::identity::{short_fingerprint, Identity};
use crate::server::{self, Decision, IncomingRequest, Limits, Receiver, ReceiverUi, RecvOutcome};
use crate::settings::{self, Settings};
use crate::{platform, transfer};
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, Notify};

/// Finished receives kept for "Show in Finder/Explorer".
const MAX_REMEMBERED: usize = 50;

pub struct AppState {
    identity: Arc<Identity>,
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    save_dir: Arc<RwLock<PathBuf>>,
    receiver: Arc<Receiver>,
    listener: Mutex<Option<(JoinHandle<()>, u16)>>,
    discovery: Option<Discovery>,
    discovery_error: Option<String>,
    devices: Arc<Mutex<Vec<Device>>>,
    selections: Mutex<HashMap<u64, Vec<OutFile>>>,
    outgoing: Mutex<HashMap<u64, Arc<Notify>>>,
    received: Arc<Mutex<HashMap<u64, Vec<PathBuf>>>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    next_id: AtomicU64,
}

// ---------- DTOs sent to the UI ----------

#[derive(Serialize)]
pub struct StateDto {
    me: MeDto,
    settings: SettingsDto,
    devices: Vec<Device>,
    discovery_error: Option<String>,
}

#[derive(Serialize)]
struct MeDto {
    name: String,
    short_fingerprint: String,
    port: u16,
    port_fallback: bool,
}

#[derive(Serialize)]
pub struct SettingsDto {
    device_name: String,
    save_dir: String,
    port: u16,
    close_to_tray: bool,
    trusted: Vec<settings::TrustedDevice>,
}

#[derive(Serialize)]
pub struct SelectionDto {
    id: u64,
    files: Vec<FileDto>,
    total: u64,
}

#[derive(Serialize, Clone)]
struct FileDto {
    name: String,
    size: u64,
}

#[derive(Serialize, Clone)]
struct IncomingDto {
    id: u64,
    sender_name: String,
    sender_os: String,
    short_fingerprint: String,
    files: Vec<server::IncomingFile>,
    total: u64,
}

#[derive(Serialize, Clone)]
struct RecvStartedDto {
    id: u64,
    sender_name: String,
    total: u64,
}

#[derive(Serialize, Clone)]
struct ProgressDto {
    id: u64,
    done: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
struct RecvFinishedDto {
    id: u64,
    /// completed | declined | timed_out | cancelled_by_sender | cancelled | failed
    outcome: &'static str,
    reason: Option<String>,
    saved: Vec<String>,
}

#[derive(Serialize, Clone)]
struct SendStatusDto {
    id: u64,
    status: SendStatus,
}

#[derive(Serialize, Clone)]
struct SendFinishedDto {
    id: u64,
    result: SendOutcome,
}

// ---------- Receiver UI bridge ----------

/// A request waiting for the user, plus who sent it (for "always accept").
struct Pending {
    tx: oneshot::Sender<Decision>,
    fingerprint: crate::identity::Fingerprint,
    name: String,
}

struct TauriUi {
    app: AppHandle,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    received: Arc<Mutex<HashMap<u64, Vec<PathBuf>>>>,
}

impl ReceiverUi for TauriUi {
    fn ask(&self, req: IncomingRequest) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        // Trusted = the key proven in this TLS handshake is on the user's list.
        let trusted = self
            .app
            .try_state::<AppState>()
            .map(|s| {
                s.settings
                    .lock()
                    .expect("lock")
                    .is_trusted(&req.fingerprint)
            })
            .unwrap_or(false);
        if trusted {
            let _ = tx.send(Decision::Accept);
            let dto = RecvStartedDto {
                id: req.id,
                sender_name: req.sender_name,
                total: req.total,
            };
            let _ = self.app.emit("recv-started", dto);
            if let Some(w) = self.app.get_webview_window("main") {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
            return rx;
        }
        self.pending.lock().expect("lock").insert(
            req.id,
            Pending {
                tx,
                fingerprint: req.fingerprint,
                name: req.sender_name.clone(),
            },
        );
        let dto = IncomingDto {
            id: req.id,
            sender_name: req.sender_name,
            sender_os: req.sender_os,
            short_fingerprint: short_fingerprint(&req.fingerprint),
            files: req.files,
            total: req.total,
        };
        let _ = self.app.emit("incoming", dto);
        show_main(&self.app);
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
        rx
    }

    fn progress(&self, id: u64, done: u64, total: u64) {
        let _ = self
            .app
            .emit("recv-progress", ProgressDto { id, done, total });
    }

    fn finished(&self, id: u64, outcome: RecvOutcome) {
        self.pending.lock().expect("lock").remove(&id);
        let (kind, reason, saved) = match outcome {
            RecvOutcome::Completed { saved } => ("completed", None, saved),
            RecvOutcome::Declined => ("declined", None, vec![]),
            RecvOutcome::TimedOut => ("timed_out", None, vec![]),
            RecvOutcome::Cancelled {
                by_sender: true,
                saved,
            } => ("cancelled_by_sender", None, saved),
            RecvOutcome::Cancelled {
                by_sender: false,
                saved,
            } => ("cancelled", None, saved),
            RecvOutcome::Failed { reason, saved } => ("failed", Some(reason), saved),
        };
        let names = saved.iter().map(|p| file_name(p)).collect();
        if !saved.is_empty() {
            let mut received = self.received.lock().expect("lock");
            received.insert(id, saved);
            // Bounded even if the UI never dismisses: drop the oldest (ids
            // only grow).
            while received.len() > MAX_REMEMBERED {
                if let Some(oldest) = received.keys().min().copied() {
                    received.remove(&oldest);
                }
            }
        }
        let _ = self.app.emit(
            "recv-finished",
            RecvFinishedDto {
                id,
                outcome: kind,
                reason,
                saved: names,
            },
        );
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------- setup ----------

pub fn setup(app: &AppHandle) -> Result<AppState, String> {
    // WHY: YON_DATA_DIR lets two dev instances run on one machine with
    // distinct identities; production always uses the platform dir.
    let data_dir = match std::env::var_os("YON_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let settings = Settings::load(&data_dir, &downloads);
    let identity = Arc::new(
        Identity::load_or_create(&data_dir).map_err(|e| format!("cannot load identity: {e}"))?,
    );
    if let Err(e) = transfer::sweep_partials(&settings.save_dir) {
        eprintln!("[yon] could not clean partial files: {e}");
    }

    let pending = Arc::new(Mutex::new(HashMap::new()));
    let received = Arc::new(Mutex::new(HashMap::new()));
    let ui = Arc::new(TauriUi {
        app: app.clone(),
        pending: pending.clone(),
        received: received.clone(),
    });
    let save_dir = Arc::new(RwLock::new(settings.save_dir.clone()));
    let receiver = Receiver::new(identity.clone(), save_dir.clone(), ui, Limits::default());

    let (discovery, discovery_error) = match Discovery::start(identity.id_hex()) {
        Ok(d) => (Some(d), None),
        Err(e) => (None, Some(format!("Device discovery unavailable: {e}"))),
    };
    let devices = Arc::new(Mutex::new(Vec::new()));
    if let Some(d) = &discovery {
        let (app, devices) = (app.clone(), devices.clone());
        if let Err(e) = d.browse(move |list| {
            *devices.lock().expect("lock") = list.clone();
            let _ = app.emit("devices", list);
        }) {
            eprintln!("[yon] browse failed: {e}");
        }
    }

    let state = AppState {
        identity,
        data_dir,
        settings: Mutex::new(settings),
        save_dir,
        receiver,
        listener: Mutex::new(None),
        discovery,
        discovery_error,
        devices,
        selections: Mutex::new(HashMap::new()),
        outgoing: Mutex::new(HashMap::new()),
        received,
        pending,
        next_id: AtomicU64::new(1),
    };
    let port = state.settings.lock().expect("lock").port;
    tauri::async_runtime::block_on(state.switch_listener(port))?;
    state.advertise()?;
    Ok(state)
}

impl AppState {
    /// (Re)bind the listener on the configured port and re-advertise.
    /// Running transfers keep their own sockets and are unaffected.
    /// Bind `port` (falling back to a free one) and swap it in. The old
    /// listener keeps serving until the new one is bound, so a failed bind
    /// leaves the receiver online. Running transfers keep their own sockets.
    async fn switch_listener(&self, port: u16) -> Result<u16, String> {
        let listener = server::bind(port)
            .await
            .map_err(|e| format!("Can't listen on port {port}: {e}"))?;
        let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
        let task = tauri::async_runtime::spawn(self.receiver.clone().serve(listener));
        if let Some((old, _)) = self.listener.lock().expect("lock").replace((task, actual)) {
            old.abort();
        }
        Ok(actual)
    }

    fn advertise(&self) -> Result<(), String> {
        if let Some(d) = &self.discovery {
            let name = self.settings.lock().expect("lock").device_name.clone();
            d.advertise(&name, self.port())
                .map_err(|e| format!("Couldn't announce this device: {e}"))?;
        }
        Ok(())
    }

    fn port(&self) -> u16 {
        self.listener
            .lock()
            .expect("lock")
            .as_ref()
            .map(|(_, p)| *p)
            .unwrap_or(0)
    }

    fn settings_dto(&self) -> SettingsDto {
        let s = self.settings.lock().expect("lock");
        SettingsDto {
            device_name: s.device_name.clone(),
            save_dir: s.save_dir.display().to_string(),
            port: s.port,
            close_to_tray: s.close_to_tray,
            trusted: s.trusted.clone(),
        }
    }

    /// Whether closing the main window should hide it instead of quitting.
    pub fn hide_on_close(&self) -> bool {
        // macOS convention: closing a window never quits the app.
        cfg!(target_os = "macos") || self.settings.lock().expect("lock").close_to_tray
    }

    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
}

// ---------- commands ----------

#[tauri::command]
pub fn get_state(state: State<'_, AppState>) -> StateDto {
    let (name, want) = {
        let s = state.settings.lock().expect("lock");
        (s.device_name.clone(), s.port)
    };
    let port = state.port();
    StateDto {
        me: MeDto {
            name,
            short_fingerprint: short_fingerprint(&state.identity.fingerprint),
            port,
            port_fallback: port != want,
        },
        settings: state.settings_dto(),
        devices: state.devices.lock().expect("lock").clone(),
        discovery_error: state.discovery_error.clone(),
    }
}

#[tauri::command]
pub async fn pick_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SelectionDto>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_files())
            .await
            .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut files = Vec::new();
    for fp in picked {
        let path = fp.into_path().map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        // Phase 1 sends files only (folders are Phase 2).
        if !meta.is_file() {
            continue;
        }
        files.push(OutFile {
            name: file_name(&path),
            size: meta.len(),
            path,
        });
    }
    if files.is_empty() {
        return Ok(None);
    }
    let id = state.id();
    let dto = SelectionDto {
        id,
        total: files.iter().map(|f| f.size).sum(),
        files: files
            .iter()
            .map(|f| FileDto {
                name: f.name.clone(),
                size: f.size,
            })
            .collect(),
    };
    state.selections.lock().expect("lock").insert(id, files);
    Ok(Some(dto))
}

#[tauri::command]
pub fn clear_selection(state: State<'_, AppState>, id: u64) {
    state.selections.lock().expect("lock").remove(&id);
}

#[tauri::command]
pub fn send(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: u64,
    device_id: String,
) -> Result<u64, String> {
    let device = state
        .devices
        .lock()
        .expect("lock")
        .iter()
        .find(|d| d.id == device_id)
        .cloned()
        .ok_or("That device is no longer available")?;
    if !device.compatible {
        return Err("That device runs an incompatible Yon version — update both devices".into());
    }
    // Checked the device first so a bad pick doesn't cost the user their
    // selection; from here the transfer owns the file list.
    let files = state
        .selections
        .lock()
        .expect("lock")
        .remove(&selection_id)
        .ok_or("Selection expired — pick the files again")?;
    let id = state.id();
    let cancel = Arc::new(Notify::new());
    state
        .outgoing
        .lock()
        .expect("lock")
        .insert(id, cancel.clone());
    let identity = state.identity.clone();
    let name = state.settings.lock().expect("lock").device_name.clone();
    let target = Target {
        addrs: device.addrs.iter().copied().map(SocketAddr::V4).collect(),
        fingerprint: device.fingerprint,
    };

    tauri::async_runtime::spawn(async move {
        let emitter = app.clone();
        let result = client::send(
            &identity,
            &name,
            platform::os_name(),
            &target,
            &files,
            cancel,
            &mut |status| {
                let _ = emitter.emit("send-status", SendStatusDto { id, status });
            },
        )
        .await;
        if let Some(state) = app.try_state::<AppState>() {
            state.outgoing.lock().expect("lock").remove(&id);
        }
        let _ = app.emit("send-finished", SendFinishedDto { id, result });
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_send(state: State<'_, AppState>, id: u64) {
    if let Some(n) = state.outgoing.lock().expect("lock").get(&id) {
        n.notify_one();
    }
}

#[tauri::command]
pub fn respond(
    state: State<'_, AppState>,
    id: u64,
    accept: bool,
    trust: bool,
) -> Result<(), String> {
    let Some(p) = state.pending.lock().expect("lock").remove(&id) else {
        return Ok(());
    };
    // WHY: the fingerprint comes from our own state (the handshake), never
    // from the webview — the UI can only say "trust whoever sent request id".
    if accept && trust {
        let mut s = state.settings.lock().expect("lock");
        s.trust(&p.fingerprint, &p.name);
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    let _ = p.tx.send(if accept {
        Decision::Accept
    } else {
        Decision::Decline
    });
    Ok(())
}

#[tauri::command]
pub fn untrust(state: State<'_, AppState>, id: String) -> Result<SettingsDto, String> {
    {
        let mut s = state.settings.lock().expect("lock");
        s.untrust(&id);
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    Ok(state.settings_dto())
}

#[tauri::command]
pub fn cancel_receive(state: State<'_, AppState>, id: u64) {
    state.receiver.cancel(id);
}

#[tauri::command]
pub fn reveal(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    let path = state
        .received
        .lock()
        .expect("lock")
        .get(&id)
        .and_then(|v| v.first().cloned())
        .ok_or("Nothing to show")?;
    platform::reveal(&path).map_err(|e| format!("Could not open file manager: {e}"))
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    device_name: String,
    port: u16,
) -> Result<StateDto, String> {
    let name = settings::validate_name(&device_name)?;
    let port = settings::validate_port(port)?;
    let old_port = state.settings.lock().expect("lock").port;
    // WHY: bind first, persist after. If the new port can't be bound we
    // return before touching config or the running listener.
    if port != old_port {
        state.switch_listener(port).await?;
    }
    {
        let mut s = state.settings.lock().expect("lock");
        s.device_name = name;
        s.port = port;
        s.save(&state.data_dir)
            .map_err(|e| format!("Applied, but couldn't save settings: {e}"))?;
    }
    state.advertise()?;
    Ok(get_state(state))
}

#[tauri::command]
pub async fn pick_save_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsDto, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| e.to_string())?;
    if let Some(fp) = picked {
        let dir = fp.into_path().map_err(|e| e.to_string())?;
        let mut s = state.settings.lock().expect("lock");
        s.save_dir = dir.clone();
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
        *state.save_dir.write().expect("lock") = dir;
    }
    Ok(state.settings_dto())
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<SettingsDto, String> {
    {
        let mut s = state.settings.lock().expect("lock");
        s.close_to_tray = enabled;
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    Ok(state.settings_dto())
}

// ---------- window + tray ----------

/// Bring the main window back (from hidden, minimized or behind others).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Menu bar (macOS) / notification area (Windows) icon with Open and Quit.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Yon", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Yon", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;

    let builder = TrayIconBuilder::with_id("main")
        .tooltip("Yon")
        .menu(&menu)
        // macOS: click opens the menu (menu bar convention). Windows: left
        // click opens the window, right click opens the menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if !cfg!(target_os = "macos") {
                    show_main(tray.app_handle());
                }
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::include_image!("./icons/tray.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };

    builder.build(app)?;
    Ok(())
}

/// The user dismissed a finished receive; its paths are no longer needed.
#[tauri::command]
pub fn forget_received(state: State<'_, AppState>, id: u64) {
    state.received.lock().expect("lock").remove(&id);
}
