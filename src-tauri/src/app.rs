//! Tauri shell: state, IPC commands and events.
//!
//! Trust boundary: the webview never sends a file-system path. Files and
//! folders are picked here in Rust; the UI only gets opaque ids plus names
//! and sizes to display.

use crate::client::{self, OutFile, SendOutcome, SendStatus, Target};
use crate::discovery::{Device, Discovery};
use crate::identity::{short_fingerprint, Identity};
use crate::link::outbox::OfferEvents;
use crate::link::remote::{self, RemoteStatus};
use crate::link::{self, Link, LinkLimits, Phone, LINK_PORT};
use crate::protocol::{hex, unhex};
use crate::server::{self, Decision, IncomingRequest, Limits, Receiver, ReceiverUi, RecvOutcome};
use crate::settings::{self, Settings};
use crate::update::{UpdateDto, UpdateProgressDto};
use crate::{platform, transfer, Throttle};
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{oneshot, Notify};

/// Finished receives kept for "Show in Finder/Explorer".
const MAX_REMEMBERED: usize = 50;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub struct AppState {
    app: AppHandle,
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
    /// Files handed to us by the OS (Send to / Open With), waiting for the UI.
    shared: Mutex<Option<SelectionDto>>,
    outgoing: Mutex<HashMap<u64, Arc<Notify>>>,
    received: Arc<Mutex<HashMap<u64, Vec<PathBuf>>>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    next_id: AtomicU64,
    link: Arc<Link>,
    /// Runs only while at least one phone is paired. Async lock: held across
    /// the bind so two quick pairings can't both try to bind the port.
    link_task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    link_error: Mutex<Option<String>>,
    /// Relay connection (ADR-003) and the URL it was started with.
    remote_task: Mutex<Option<(JoinHandle<()>, String)>>,
    remote_status: Arc<Mutex<Option<RemoteStatus>>>,
    /// The pending-pairing expiry loop is running. Changed only while the
    /// settings lock is held, so a new pending pairing can't be missed.
    expiry_running: AtomicBool,
    /// Newest version found by the last check, ready to install.
    update: Mutex<Option<Update>>,
    updating: AtomicBool,
}

// ---------- DTOs sent to the UI ----------

#[derive(Serialize)]
pub struct StateDto {
    me: MeDto,
    settings: SettingsDto,
    devices: Vec<Device>,
    discovery_error: Option<String>,
    /// Paired phones whose Yon page is open right now (ids, hex).
    online_phones: Vec<String>,
}

#[derive(Serialize)]
struct MeDto {
    name: String,
    short_fingerprint: String,
    port: u16,
    port_fallback: bool,
    version: &'static str,
}

#[derive(Serialize, Clone)]
pub struct SettingsDto {
    device_name: String,
    save_dir: String,
    port: u16,
    close_to_tray: bool,
    show_in_dock: bool,
    check_updates: bool,
    trusted: Vec<settings::TrustedDevice>,
    /// Never includes the pairing keys.
    phones: Vec<PhoneDto>,
    link_error: Option<String>,
    remote: bool,
    relay_url: String,
    /// Built-in relay of this build (normalized), if any.
    default_relay: Option<String>,
    /// Relay "Reach from anywhere" uses: the override, else the built-in.
    effective_relay: Option<String>,
    remote_status: Option<RemoteStatus>,
}

#[derive(Serialize, Clone)]
struct PhoneDto {
    id: String,
    name: String,
    created: u64,
    note: Option<settings::Note>,
    /// Waiting for "Pair again" to be confirmed; hidden in the list.
    pending: bool,
}

#[derive(Serialize)]
pub struct CancelDto {
    outcome: &'static str,
    settings: SettingsDto,
}

#[derive(Serialize)]
struct QrDto {
    url: String,
    /// Modules per side.
    size: usize,
    /// SVG path of the dark modules, one unit per module.
    path: String,
}

impl QrDto {
    fn new(url: String) -> Result<Self, String> {
        let (size, path) = link::qr_svg_path(&url).ok_or("Couldn't make the QR code")?;
        Ok(Self { url, size, path })
    }
}

#[derive(Serialize)]
pub struct PairDto {
    phone_id: String,
    /// "Reach from anywhere" on: the relay page link. Otherwise the
    /// `yon-….local` address (keeps working when the computer's IP changes).
    qr: QrDto,
    /// Anywhere on: the LAN link (fastest at home). Otherwise the same link by
    /// IP, for phones that can't resolve `.local`.
    fallback: Option<QrDto>,
    anywhere: bool,
    settings: SettingsDto,
}

#[derive(Serialize, Clone)]
pub struct SelectionDto {
    id: u64,
    files: Vec<FileDto>,
    total: u64,
}

#[derive(Serialize, Clone)]
struct FileDto {
    name: String,
    size: u64,
    dir: Option<String>,
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

/// Files the OS puts in folders on its own; never worth sending.
const CLUTTER: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

fn too_many() -> String {
    format!(
        "That's more than {} files. Send fewer at a time.",
        crate::protocol::MAX_FILES
    )
}

/// What to send for the paths a person picked: files as they are, folders
/// with everything inside. Inside folders, links are skipped, not followed,
/// so a folder can't pull in files from elsewhere.
fn collect_files(paths: Vec<PathBuf>) -> Result<Vec<OutFile>, String> {
    let mut out = Vec::new();
    let mut roots = std::collections::HashSet::new();
    for path in paths {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            // WHY: two picked folders both called "Photos" stay apart on
            // the other side instead of merging into one.
            let name = file_name(&path);
            let root = (1..)
                .map(|n| {
                    if n == 1 {
                        name.clone()
                    } else {
                        format!("{name} ({n})")
                    }
                })
                .find(|r| roots.insert(r.to_lowercase()))
                .expect("unbounded");
            walk(&path, root, 1, &mut out)?;
        } else if meta.is_file() {
            out.push(OutFile {
                name: file_name(&path),
                size: meta.len(),
                path,
                dir: None,
            });
        }
        if out.len() > crate::protocol::MAX_FILES {
            return Err(too_many());
        }
    }
    Ok(out)
}

fn walk(dir: &Path, rel: String, depth: usize, out: &mut Vec<OutFile>) -> Result<(), String> {
    if depth > crate::protocol::MAX_DIR_DEPTH {
        return Err(format!("\"{rel}\" has too many folders inside folders."));
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("Can't open the folder \"{rel}\": {e}"))?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() || CLUTTER.contains(&name.as_str()) {
            continue;
        }
        if kind.is_dir() {
            walk(&entry.path(), format!("{rel}/{name}"), depth + 1, out)?;
        } else if kind.is_file() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            out.push(OutFile {
                name,
                size: meta.len(),
                path: entry.path(),
                dir: Some(rel.clone()),
            });
            if out.len() > crate::protocol::MAX_FILES {
                return Err(too_many());
            }
        }
    }
    Ok(())
}

fn selection_dto(id: u64, files: &[OutFile]) -> SelectionDto {
    SelectionDto {
        id,
        total: files.iter().map(|f| f.size).sum(),
        files: files
            .iter()
            .map(|f| FileDto {
                name: f.name.clone(),
                size: f.size,
                dir: f.dir.clone(),
            })
            .collect(),
    }
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
    let mut settings = Settings::load(&data_dir, &downloads);
    // WHY: before Link starts, so a pairing left pending by a crash or a
    // forced quit can't authenticate after its time is up.
    match settings::expire_pending(&settings, unix_now(), |n| n.save(&data_dir)) {
        Ok(Some(next)) => settings = next,
        Ok(None) => {}
        Err(e) => eprintln!("[yon] couldn't save pairing change: {e}"),
    }
    let has_pending = settings.has_pending();
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
    let link = Link::new(
        receiver.clone(),
        settings.device_name.clone(),
        LinkLimits::default(),
    );

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
        app: app.clone(),
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
        shared: Mutex::new(None),
        outgoing: Mutex::new(HashMap::new()),
        received,
        pending,
        next_id: AtomicU64::new(1),
        link,
        link_task: tokio::sync::Mutex::new(None),
        link_error: Mutex::new(None),
        remote_task: Mutex::new(None),
        remote_status: Arc::new(Mutex::new(None)),
        expiry_running: AtomicBool::new(false),
        update: Mutex::new(None),
        updating: AtomicBool::new(false),
    };
    let port = state.settings.lock().expect("lock").port;
    tauri::async_runtime::block_on(state.switch_listener(port))?;
    state.link.set_relay_dir(state.data_dir.join("relay"));
    tauri::async_runtime::block_on(state.sync_link());
    let presence_app = app.clone();
    state.link.set_presence_listener(Arc::new(move || {
        if let Some(s) = presence_app.try_state::<AppState>() {
            let _ = presence_app.emit("phones-online", s.online_phones());
        }
    }));
    let auth_app = app.clone();
    state.link.set_on_authenticated(Arc::new(move |id| {
        // WHY: called from inside a Link request; finish on another task
        // so saving and `sync_link` never run under Link's session lock.
        let app = auth_app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(state) = app.try_state::<AppState>() {
                state.complete_pairing(&hex(&id)).await;
            }
        });
    }));
    if has_pending {
        state.ensure_expiry_timer();
    }
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

    /// Hand the paired phones to Link and run its listener only while there
    /// are any. The port is fixed (saved phone links point at it), so a busy
    /// port is reported in Settings instead of silently moving.
    async fn sync_link(&self) {
        let phones: Vec<Phone> = self
            .settings
            .lock()
            .expect("lock")
            .phones
            .iter()
            .filter_map(|p| {
                Some(Phone {
                    id: unhex::<16>(&p.id)?,
                    key: unhex::<32>(&p.key)?,
                    name: p.name.clone(),
                })
            })
            .collect();
        let want = !phones.is_empty();
        self.link.set_phones(phones);
        self.sync_remote(want);
        let mut task = self.link_task.lock().await;
        if !want {
            if let Some(t) = task.take() {
                t.abort();
            }
            *self.link_error.lock().expect("lock") = None;
            return;
        }
        if task.is_some() {
            return;
        }
        let error = match Link::bind(LINK_PORT).await {
            Ok(listener) => {
                *task = Some(tauri::async_runtime::spawn(
                    self.link.clone().serve(listener),
                ));
                None
            }
            Err(e) => {
                eprintln!("[yon] link port {LINK_PORT} unavailable: {e}");
                Some(format!(
                    "Phones can't connect: port {LINK_PORT} is used by another program. Quit it, then quit and reopen Yon."
                ))
            }
        };
        *self.link_error.lock().expect("lock") = error;
    }

    fn online_phones(&self) -> Vec<String> {
        self.link.online_phones().iter().map(|p| hex(p)).collect()
    }

    /// Run the relay connection only while it's on, configured, and there
    /// are phones to serve; restart it when the relay address changes.
    fn sync_remote(&self, have_phones: bool) {
        let (on, url, secret) = {
            let s = self.settings.lock().expect("lock");
            (
                s.remote,
                settings::effective_relay(&s).unwrap_or_default(),
                crate::protocol::unhex::<32>(&s.room_secret),
            )
        };
        let wanted = secret.filter(|_| on && have_phones && !url.is_empty());
        let mut task = self.remote_task.lock().expect("lock");
        let running_here = task.as_ref().is_some_and(|(_, u)| *u == url);
        if wanted.is_some() && running_here {
            return;
        }
        if let Some((t, _)) = task.take() {
            t.abort();
        }
        *self.remote_status.lock().expect("lock") = None;
        let Some(secret) = wanted else {
            return;
        };
        let (app, status) = (self.app.clone(), self.remote_status.clone());
        let handle = tauri::async_runtime::spawn(remote::run(
            self.link.clone(),
            url.clone(),
            secret,
            link::CHUNK + 64,
            move |st| {
                *status.lock().expect("lock") = Some(st.clone());
                let _ = app.emit("remote-status", st);
            },
        ));
        *task = Some((handle, url));
    }

    /// The `.local` name mDNS announces for this computer (see discovery).
    fn link_host(&self) -> String {
        format!("yon-{}.local", &self.identity.id_hex()[..16])
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

    fn emit_settings(&self) {
        let _ = self.app.emit("settings-changed", self.settings_dto());
    }

    /// A phone proved its key; finish a "Pair again" if it was pending.
    async fn complete_pairing(&self, id: &str) {
        let changed = {
            let mut s = self.settings.lock().expect("lock");
            match settings::complete_replacement(&s, id, |n| n.save(&self.data_dir)) {
                Ok(Some(next)) => {
                    *s = next;
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    eprintln!("[yon] couldn't save pairing change: {e}");
                    false
                }
            }
        };
        if changed {
            self.sync_link().await;
            self.emit_settings();
        }
    }

    /// Drop expired pending pairings. Returns whether any pending remain.
    async fn expire_pairings(&self) -> bool {
        let (changed, pending) = {
            let mut s = self.settings.lock().expect("lock");
            let changed = match settings::expire_pending(&s, unix_now(), |n| n.save(&self.data_dir))
            {
                Ok(Some(next)) => {
                    *s = next;
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    eprintln!("[yon] couldn't save pairing change: {e}");
                    false
                }
            };
            let pending = s.has_pending();
            if !pending {
                // WHY: cleared under the settings lock — `pair_phone` adds a
                // pending record under the same lock, then starts the loop.
                self.expiry_running.store(false, Ordering::SeqCst);
            }
            (changed, pending)
        };
        if changed {
            self.sync_link().await;
            self.emit_settings();
        }
        pending
    }

    /// Run the 60 s expiry loop while pending pairings exist.
    fn ensure_expiry_timer(&self) {
        if self.expiry_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let Some(state) = app.try_state::<AppState>() else {
                    continue;
                };
                if !state.expire_pairings().await {
                    break;
                }
            }
        });
    }

    fn settings_dto(&self) -> SettingsDto {
        let s = self.settings.lock().expect("lock");
        let effective = settings::effective_relay(&s);
        SettingsDto {
            device_name: s.device_name.clone(),
            save_dir: s.save_dir.display().to_string(),
            port: s.port,
            close_to_tray: s.close_to_tray,
            show_in_dock: s.show_in_dock,
            check_updates: s.check_updates,
            trusted: s.trusted.clone(),
            phones: s
                .phones
                .iter()
                .map(|p| PhoneDto {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    created: p.created,
                    note: settings::phone_note(p, s.remote, effective.as_deref()),
                    pending: p.replaces.is_some(),
                })
                .collect(),
            link_error: self.link_error.lock().expect("lock").clone(),
            remote: s.remote,
            relay_url: s.relay_url.clone(),
            default_relay: settings::default_relay(),
            effective_relay: effective,
            remote_status: self.remote_status.lock().expect("lock").clone(),
        }
    }

    pub fn settings_show_in_dock(&self) -> bool {
        self.settings.lock().expect("lock").show_in_dock
    }

    /// Whether closing the main window should hide it instead of quitting.
    pub fn hide_on_close(&self) -> bool {
        // macOS convention: closing a window never quits the app.
        cfg!(target_os = "macos") || self.settings.lock().expect("lock").close_to_tray
    }

    /// Turn picked paths into a stored selection (paths stay here; the UI
    /// gets names, folders and sizes).
    fn make_selection(&self, paths: Vec<PathBuf>) -> Result<SelectionDto, String> {
        let files = collect_files(paths)?;
        if files.is_empty() {
            return Err("There's nothing to send in there.".into());
        }
        let id = self.id();
        let dto = selection_dto(id, &files);
        self.selections.lock().expect("lock").insert(id, files);
        Ok(dto)
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
            version: env!("CARGO_PKG_VERSION"),
        },
        settings: state.settings_dto(),
        devices: state.devices.lock().expect("lock").clone(),
        discovery_error: state.discovery_error.clone(),
        online_phones: state.online_phones(),
    }
}

#[tauri::command]
pub async fn pick_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SelectionDto>, String> {
    match pick_paths(app, false).await? {
        Some(paths) => state.make_selection(paths).map(Some),
        None => Ok(None),
    }
}

/// Ask for files (or folders) and add them to a selection being confirmed.
#[tauri::command]
pub async fn add_to_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    folders: bool,
) -> Result<Option<SelectionDto>, String> {
    let Some(paths) = pick_paths(app, folders).await? else {
        return Ok(None);
    };
    let more = collect_files(paths)?;
    let mut selections = state.selections.lock().expect("lock");
    let files = selections
        .get_mut(&id)
        .ok_or("Those files are no longer selected.")?;
    if files.len() + more.len() > crate::protocol::MAX_FILES {
        return Err(too_many());
    }
    files.extend(more);
    Ok(Some(selection_dto(id, files)))
}

/// Ask for folders to send.
#[tauri::command]
pub async fn pick_folders(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SelectionDto>, String> {
    match pick_paths(app, true).await? {
        Some(paths) => state.make_selection(paths).map(Some),
        None => Ok(None),
    }
}

async fn pick_paths(app: AppHandle, folders: bool) -> Result<Option<Vec<PathBuf>>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        if folders {
            dialog.blocking_pick_folders()
        } else {
            dialog.blocking_pick_files()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    picked
        .into_iter()
        .map(|fp| fp.into_path().map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()
        .map(Some)
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
    if let Some(phone) = device_id.strip_prefix("phone:") {
        return send_to_phone(app, &state, selection_id, phone);
    }
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

/// Computer → phone over Yon Link: the phone's page picks the offer up.
fn send_to_phone(
    app: AppHandle,
    state: &AppState,
    selection_id: u64,
    phone: &str,
) -> Result<u64, String> {
    let phone = unhex::<16>(phone).ok_or("Unknown phone")?;
    let files = state
        .selections
        .lock()
        .expect("lock")
        .remove(&selection_id)
        .ok_or("Selection expired — pick the files again")?;
    let id = state.id();
    let events = Arc::new(PhoneOfferEvents {
        app: app.clone(),
        id,
    });
    // Tracked like other sends so an update waits for it; added first so a
    // quick finish can't leave a stale entry behind.
    state
        .outgoing
        .lock()
        .expect("lock")
        .insert(id, Arc::new(Notify::new()));
    if let Err(e) = state.link.offer(id, phone, files.clone(), events) {
        state.outgoing.lock().expect("lock").remove(&id);
        // Keep the selection so the user can pick another device.
        state
            .selections
            .lock()
            .expect("lock")
            .insert(selection_id, files);
        return Err(e);
    }
    Ok(id)
}

struct PhoneOfferEvents {
    app: AppHandle,
    id: u64,
}

impl OfferEvents for PhoneOfferEvents {
    fn status(&self, status: SendStatus) {
        let _ = self.app.emit(
            "send-status",
            SendStatusDto {
                id: self.id,
                status,
            },
        );
    }

    fn finished(&self, result: SendOutcome) {
        if let Some(state) = self.app.try_state::<AppState>() {
            state.outgoing.lock().expect("lock").remove(&self.id);
        }
        let _ = self.app.emit(
            "send-finished",
            SendFinishedDto {
                id: self.id,
                result,
            },
        );
    }
}

#[tauri::command]
pub fn cancel_send(state: State<'_, AppState>, id: u64) {
    state.link.cancel_offer(id);
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
        s.device_name = name.clone();
        s.port = port;
        s.save(&state.data_dir)
            .map_err(|e| format!("Applied, but couldn't save settings: {e}"))?;
    }
    state.link.set_computer_name(name);
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

#[tauri::command]
pub fn set_show_in_dock(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<SettingsDto, String> {
    {
        let mut s = state.settings.lock().expect("lock");
        s.show_in_dock = enabled;
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    apply_dock_visibility(&app, enabled);
    Ok(state.settings_dto())
}

/// Pair a phone, or with `replaces` start "Pair again" for an existing one:
/// the new pairing stays pending (the old one keeps working) until the phone
/// proves the new key. The key leaves Rust only inside this one-time URL.
#[tauri::command]
pub async fn pair_phone(
    state: State<'_, AppState>,
    name: String,
    replaces: Option<String>,
) -> Result<PairDto, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let name = settings::validate_name(&name)?;
    let (mut id, mut key) = ([0u8; 16], [0u8; 32]);
    let rng = SystemRandom::new();
    rng.fill(&mut id)
        .and_then(|_| rng.fill(&mut key))
        .map_err(|_| "Couldn't create a pairing key")?;
    state.expire_pairings().await;
    let anywhere_relay = {
        let mut s = state.settings.lock().expect("lock");
        if let Some(old) = &replaces {
            if !s
                .phones
                .iter()
                .any(|p| p.id == *old && p.replaces.is_none())
            {
                return Err("Unknown phone".into());
            }
        }
        let relay = settings::effective_relay(&s).filter(|_| s.remote);
        let mut next = s.clone();
        if let Some(old) = &replaces {
            // A second "Pair again" for the same phone supersedes the first.
            next.phones.retain(|p| p.replaces.as_ref() != Some(old));
        }
        if !next.add_phone(settings::PairedPhone {
            id: hex(&id),
            key: hex(&key),
            name: name.clone(),
            created: unix_now(),
            relay: relay.clone().unwrap_or_default(),
            replaces: replaces.clone(),
        }) {
            return Err("Too many phones paired. Remove one first.".into());
        }
        next.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
        *s = next;
        relay
    };
    // WHY: started after the lock is released; the loop clears its flag
    // under the settings lock, so this new pending record can't be missed.
    if replaces.is_some() {
        state.ensure_expiry_timer();
    }
    state.sync_link().await;
    let phone = Phone { id, key, name };
    let anywhere = {
        let s = state.settings.lock().expect("lock");
        match (unhex::<32>(&s.room_secret), &anywhere_relay) {
            (Some(secret), Some(relay)) => {
                Some(link::anywhere_url(&phone, &remote::room_id(&secret), relay))
            }
            _ => None,
        }
    };
    let (qr, fallback) = match &anywhere {
        // WHY: no Wi-Fi-only code in anywhere mode — one pairing, one link.
        Some(url) => (QrDto::new(url.clone())?, None),
        None => (
            QrDto::new(link::pairing_url(&state.link_host(), &phone))?,
            match link::lan_ipv4() {
                Some(ip) => Some(QrDto::new(link::pairing_url(&ip.to_string(), &phone))?),
                None => None,
            },
        ),
    };
    Ok(PairDto {
        phone_id: hex(&id),
        qr,
        fallback,
        anywhere: anywhere.is_some(),
        settings: state.settings_dto(),
    })
}

/// Forget a phone: its saved link stops working at once, and "always
/// accept" for it is removed too.
#[tauri::command]
pub async fn unpair_phone(state: State<'_, AppState>, id: String) -> Result<SettingsDto, String> {
    let pair = unhex::<16>(&id).ok_or("Unknown phone")?;
    {
        let mut s = state.settings.lock().expect("lock");
        s.remove_phone(&id);
        s.untrust(&hex(&link::phone_fingerprint(&pair)));
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    state.sync_link().await;
    Ok(state.settings_dto())
}

/// The pairing sheet closed before a "Pair again" was confirmed.
#[tauri::command]
pub async fn cancel_pairing(state: State<'_, AppState>, id: String) -> Result<CancelDto, String> {
    let (outcome, changed) = {
        let mut s = state.settings.lock().expect("lock");
        match settings::cancel_pending(&s, &id, |n| n.save(&state.data_dir)) {
            Ok(settings::CancelOutcome::Cancelled(next)) => {
                *s = next;
                ("cancelled", true)
            }
            Ok(settings::CancelOutcome::Completed) => ("completed", false),
            Ok(settings::CancelOutcome::NotFound) => ("not_found", false),
            Err(e) => {
                eprintln!("[yon] couldn't save pairing change: {e}");
                return Err(format!("Could not save settings: {e}"));
            }
        }
    };
    if changed {
        state.sync_link().await;
    }
    Ok(CancelDto {
        outcome,
        settings: state.settings_dto(),
    })
}

// ---------- updates ----------

const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Ask GitHub Releases for a newer version. Remembers it for
/// `install_update`; `None` = up to date.
async fn find_update(app: &AppHandle) -> Result<Option<UpdateDto>, String> {
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let dto = found.as_ref().map(|u| UpdateDto {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    if let Some(state) = app.try_state::<AppState>() {
        *state.update.lock().expect("lock") = found;
    }
    Ok(dto)
}

/// Clean up after earlier updates, then check shortly after launch and
/// every few hours while the setting is on. Failures (offline) stay quiet.
pub fn start_updates(app: &AppHandle) {
    let removed = crate::update::sweep_leftovers(&std::env::temp_dir(), &app.package_info().name);
    if removed > 0 {
        eprintln!("[yon] removed {removed} leftover update folder(s)");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        loop {
            let enabled = app
                .try_state::<AppState>()
                .is_some_and(|s| s.settings.lock().expect("lock").check_updates);
            if enabled {
                match find_update(&app).await {
                    Ok(Some(dto)) => {
                        let _ = app.emit("update-available", dto);
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("[yon] {e}"),
                }
            }
            tokio::time::sleep(UPDATE_EVERY).await;
        }
    });
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateDto>, String> {
    find_update(&app).await
}

/// Download, verify the signature, install and restart. On Windows the
/// installer takes over and the app exits during this call.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // WHY: restarting would cut off transfers in progress.
    if state.receiver.is_busy() || !state.outgoing.lock().expect("lock").is_empty() {
        return Err("Wait for the current transfer to finish, then update.".into());
    }
    let update = state
        .update
        .lock()
        .expect("lock")
        .clone()
        .ok_or("No update to install. Check again.")?;
    if state.updating.swap(true, Ordering::SeqCst) {
        return Err("Already updating".into());
    }
    let (mut done, mut throttle, emitter) = (0u64, Throttle::new(), app.clone());
    let result = update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                if throttle.ready(total == Some(done)) {
                    let _ = emitter.emit("update-progress", UpdateProgressDto { done, total });
                }
            },
            || {},
        )
        .await;
    state.updating.store(false, Ordering::SeqCst);
    result.map_err(|e| format!("Update failed: {e}"))?;
    // WHY: otherwise macOS refuses to open the relaunched app as "damaged";
    // see platform::unquarantine_own_bundle.
    #[cfg(target_os = "macos")]
    if let Err(e) = crate::platform::unquarantine_own_bundle() {
        eprintln!("[yon] could not clear quarantine on the updated app: {e}");
    }
    // WHY: free the single-instance lock first, or the relaunched app can
    // find this (still exiting) process, hand over to it and quit.
    #[cfg(desktop)]
    tauri_plugin_single_instance::destroy(&app);
    app.restart()
}

/// Turn "Reach from anywhere" on/off and set the relay address.
#[tauri::command]
pub async fn set_remote(
    state: State<'_, AppState>,
    enabled: bool,
    relay_url: String,
) -> Result<SettingsDto, String> {
    let relay_url = settings::validate_relay_url(&relay_url)?;
    {
        let mut s = state.settings.lock().expect("lock");
        let mut next = s.clone();
        next.remote = enabled;
        next.relay_url = relay_url;
        if enabled && settings::effective_relay(&next).is_none() {
            return Err("Add a relay address under Advanced to turn this on.".into());
        }
        if enabled && next.room_secret.is_empty() {
            use ring::rand::{SecureRandom, SystemRandom};
            let mut secret = [0u8; 32];
            SystemRandom::new()
                .fill(&mut secret)
                .map_err(|_| "Couldn't create a room secret")?;
            next.room_secret = hex(&secret);
        }
        next.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
        *s = next;
    }
    state.sync_link().await;
    Ok(state.settings_dto())
}

#[tauri::command]
pub fn set_check_updates(state: State<'_, AppState>, enabled: bool) -> Result<SettingsDto, String> {
    {
        let mut s = state.settings.lock().expect("lock");
        s.check_updates = enabled;
        s.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
    }
    Ok(state.settings_dto())
}

/// macOS: hide/show the Dock icon. Yon stays reachable from the menu bar.
pub fn apply_dock_visibility(_app: &AppHandle, _visible: bool) {
    #[cfg(target_os = "macos")]
    if let Err(e) = _app.set_dock_visibility(_visible) {
        eprintln!("[yon] could not change Dock visibility: {e}");
    }
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

// ---------- files handed over by the OS ----------

/// Paths from a command line (Windows "Send to" runs `yon.exe <files…>`).
/// Skips the program name and flags; relative paths resolve against `cwd`.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .collect()
}

/// Files from "Send to" / "Open With" / Dock drop: stash them and bring the
/// window up with a device picker. Never sends on its own — any local
/// program can launch us with paths, so a person must pick and confirm.
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    show_main(app);
    let app = app.clone();
    // WHY: off the main thread — a big folder takes a moment to list.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        match state.make_selection(paths) {
            Ok(selection) => {
                if let Some(old) = state.shared.lock().expect("lock").replace(selection) {
                    state.selections.lock().expect("lock").remove(&old.id);
                }
                let _ = app.emit("shared", ());
            }
            Err(e) => {
                let _ = app.emit("selection-error", e);
            }
        }
    });
}

#[derive(Serialize, Clone)]
struct DropHoverDto {
    x: f64,
    y: f64,
    /// Files and folders being dragged; sent when the drag enters.
    files: Option<usize>,
    folders: Option<usize>,
}

#[derive(Serialize, Clone)]
struct DroppedDto {
    selection: SelectionDto,
    /// Where the files were dropped, in CSS pixels of the window.
    x: f64,
    y: f64,
}

/// Files are being dragged over the window: tell the UI where (CSS px) so
/// it can highlight the device under the pointer; `None` = drag left.
pub fn drop_hover(app: &AppHandle, at: Option<(f64, f64)>, counts: Option<(usize, usize)>) {
    let _ = app.emit(
        "drop-hover",
        at.map(|(x, y)| DropHoverDto {
            x,
            y,
            files: counts.map(|c| c.0),
            folders: counts.map(|c| c.1),
        }),
    );
}

/// Files dropped on the window: stash them (paths stay here) and let the UI
/// ask for confirmation, for the device under the drop point if any.
pub fn dropped(app: &AppHandle, paths: Vec<PathBuf>, (x, y): (f64, f64)) {
    // WHY: the drop came from another app (Finder), which is still active;
    // without this the first click on the confirm sheet only activates Yon.
    show_main(app);
    let app = app.clone();
    // WHY: off the main thread — a big folder takes a moment to list.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let _ = match state.make_selection(paths) {
            Ok(selection) => app.emit("dropped", DroppedDto { selection, x, y }),
            Err(e) => app.emit("selection-error", e),
        };
    });
}

/// The UI asks for pending OS-shared files (on load, and on each "shared").
#[tauri::command]
pub fn take_shared(state: State<'_, AppState>) -> Option<SelectionDto> {
    state.shared.lock().expect("lock").take()
}

#[cfg(test)]
mod tests {
    use super::{collect_files, paths_from_args};

    #[test]
    fn folders_are_walked_without_links_or_clutter() {
        let root = crate::identity::tests::temp_dir("collect");
        let top = root.join("Trip");
        std::fs::create_dir_all(top.join("day 2")).unwrap();
        std::fs::write(top.join("b.jpg"), b"bb").unwrap();
        std::fs::write(top.join("a.jpg"), b"a").unwrap();
        std::fs::write(top.join(".DS_Store"), b"x").unwrap();
        std::fs::write(top.join("day 2").join("c.jpg"), b"ccc").unwrap();
        std::fs::write(root.join("loose.txt"), b"l").unwrap();
        #[cfg(unix)]
        {
            let outside = root.join("outside");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("secret"), b"s").unwrap();
            std::os::unix::fs::symlink(&outside, top.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret"), top.join("s")).unwrap();
        }

        let twin = root.join("other").join("Trip");
        std::fs::create_dir_all(&twin).unwrap();
        std::fs::write(twin.join("z.jpg"), b"z").unwrap();
        let files =
            collect_files(vec![top, root.join("loose.txt"), root.join("gone"), twin]).unwrap();
        let got: Vec<_> = files
            .iter()
            .map(|f| (f.dir.as_deref(), f.name.as_str(), f.size))
            .collect();
        assert_eq!(
            got,
            [
                (Some("Trip"), "a.jpg", 1),
                (Some("Trip"), "b.jpg", 2),
                (Some("Trip/day 2"), "c.jpg", 3),
                (None, "loose.txt", 1),
                (Some("Trip (2)"), "z.jpg", 1),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    use std::path::{Path, PathBuf};

    #[test]
    fn args_skip_program_and_flags_and_resolve_relative() {
        let cwd = Path::new(if cfg!(windows) { "C:\\work" } else { "/work" });
        let abs = if cfg!(windows) {
            "C:\\x\\a.txt"
        } else {
            "/x/a.txt"
        };
        let args: Vec<String> = ["yon.exe", "--flag", abs, "b.txt"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            paths_from_args(&args, cwd),
            vec![PathBuf::from(abs), cwd.join("b.txt")]
        );
        assert!(paths_from_args(&["yon".to_string()], cwd).is_empty());
    }
}
