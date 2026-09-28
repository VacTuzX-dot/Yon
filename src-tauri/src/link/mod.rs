//! Yon Link: phones send files to this computer through a paired web page.
//! See docs/adr/ADR-001-yon-link-web-mode.md and docs/threat-model-yon-link.md.
//!
//! Routes (one HTTP request per connection):
//! - `GET /`, `/link.js`, `/link.css`, `/icon.png` — the page (no secrets; the pairing key
//!   stays in the URL fragment on the phone).
//! - `GET /hello?p=<pair id>&nc=<nonce>` — start a session (rate limited).
//! - Sealed (AEAD, see `crypto`): `POST /request`, `POST /chunk?f=&i=`,
//!   `POST /status`, `POST /done`, `POST /cancel`. Anything that fails to open
//!   gets the same 404 as an unknown route.

pub mod crypto;
pub mod http;
pub mod outbox;
pub mod remote;

use crate::client::{OutFile, SendOutcome, SendStatus};
use crate::identity::Fingerprint;
use crate::protocol::{hex, unhex, FileMeta, TransferRequest};
use crate::server::{is_allowed_peer, Admission, Decision, Receiver, RecvOutcome, Refusal};
use crate::transfer::Reserved;
use crate::{platform, Throttle};
use crypto::{Dir, ReplayWindow, SessionKey};
use http::{read_request, write_response, HttpError, Request};
use outbox::{read_chunk, Offer, OfferEvents};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;

/// Fixed so a phone's saved Home Screen link keeps working.
pub const LINK_PORT: u16 = 53421;
/// Plaintext bytes per upload request.
pub const CHUNK: usize = 1 << 20;
const MAX_SESSIONS: usize = 64;
const HELLO_PER_MINUTE: u32 = 20;

const PAGE_HTML: &str = include_str!("../../link-dist/link.html");
const PAGE_JS: &str = include_str!("../../link-dist/link.js");
const PAGE_CSS: &str = include_str!("../../link-dist/link.css");
const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128@2x.png");

#[derive(Clone, Debug)]
pub struct LinkLimits {
    pub session_idle: Duration,
    pub http: http::Limits,
    pub max_conns: usize,
    /// How long an offer to a phone waits to be accepted.
    pub offer_wait: Duration,
    /// How long `/inbox` holds a request open waiting for an offer.
    pub inbox_wait: Duration,
    /// A phone counts as online this long after its last request.
    pub online_for: Duration,
}

impl Default for LinkLimits {
    fn default() -> Self {
        Self {
            session_idle: Duration::from_secs(300),
            http: http::Limits {
                head_timeout: Duration::from_secs(10),
                body_timeout: Duration::from_secs(60),
                max_body: CHUNK + 64,
            },
            max_conns: 16,
            offer_wait: Duration::from_secs(10 * 60),
            inbox_wait: Duration::from_secs(20),
            online_for: Duration::from_secs(35),
        }
    }
}

#[derive(Clone)]
pub struct Phone {
    pub id: [u8; 16],
    pub key: [u8; 32],
    pub name: String,
}

/// Stable identity for a paired phone, so trust ("Always accept") works the
/// same way as for desktop devices. Domain-separated from TLS fingerprints.
pub fn phone_fingerprint(id: &[u8; 16]) -> Fingerprint {
    let mut data = b"yon-link phone\0".to_vec();
    data.extend_from_slice(id);
    let d = ring::digest::digest(&ring::digest::SHA256, &data);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

/// Receives the phone id when a session first proves its pairing key.
pub type OnAuthenticated = Arc<dyn Fn([u8; 16]) + Send + Sync>;

pub struct Link {
    receiver: Arc<Receiver>,
    phones: RwLock<HashMap<[u8; 16], Phone>>,
    sessions: Mutex<HashMap<[u8; 16], Arc<tokio::sync::Mutex<Session>>>>,
    hello_rate: Mutex<HashMap<Ipv4Addr, (Instant, u32)>>,
    computer_name: RwLock<String>,
    slots: Arc<Semaphore>,
    rng: SystemRandom,
    limits: LinkLimits,
    /// Computer → phone: at most one offer per phone.
    offers: Mutex<HashMap<[u8; 16], Offer>>,
    /// Wakes `/inbox` long-polls when an offer is added.
    inbox: tokio::sync::Notify,
    /// Last request per phone, for "online" in the device list.
    seen: Mutex<HashMap<[u8; 16], Instant>>,
    on_presence: RwLock<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Called once per session when a phone first proves its pairing key.
    on_authenticated: RwLock<Option<OnAuthenticated>>,
    /// Holds phone → phone files between upload and download.
    relay_root: RwLock<PathBuf>,
}

struct Session {
    phone_id: [u8; 16],
    phone_name: String,
    ip: Ipv4Addr,
    key: SessionKey,
    inbound: ReplayWindow,
    out: u64,
    last_seen: Instant,
    upload: Option<Upload>,
    /// The pairing key has been proven in this session (see `sealed`).
    authed: bool,
}

struct Upload {
    admission: Admission,
    file: usize,
    next: u64,
    current: Option<Writing>,
    saved: Vec<PathBuf>,
    done_bytes: u64,
    throttle: Throttle,
    /// Phone ↔ phone: stored in a relay folder, then offered to this phone
    /// instead of landing in the desktop's save folder.
    relay_to: Option<[u8; 16]>,
}

struct Writing {
    // Field order matters: the file handle must close before `reserved`
    // cleans up on drop (Windows can't delete open files).
    file: tokio::fs::File,
    reserved: Reserved,
    written: u64,
}

#[derive(Deserialize)]
struct RequestBody {
    files: Vec<FileMeta>,
    /// Another paired phone (a handle from `/peers`); absent = this computer.
    #[serde(default)]
    to: Option<String>,
}

/// Relay offers get ids in their own range (below 2^53 so the page can
/// hold them as numbers) so they never collide with desktop send ids.
const RELAY_ID_BASE: u64 = 1 << 52;

/// Name other phones see for a phone: derived from its fingerprint, so the
/// pairing id itself is never shown to other phones.
fn phone_handle(id: &[u8; 16]) -> String {
    hex(&phone_fingerprint(id)[..8])
}

/// Deletes a relayed transfer's folder once the receiving phone is done.
struct RelayCleanup(PathBuf);

impl OfferEvents for RelayCleanup {
    fn status(&self, _: SendStatus) {}
    fn finished(&self, _: SendOutcome) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Link {
    pub fn new(receiver: Arc<Receiver>, computer_name: String, limits: LinkLimits) -> Arc<Self> {
        Arc::new(Self {
            receiver,
            phones: RwLock::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            hello_rate: Mutex::new(HashMap::new()),
            computer_name: RwLock::new(computer_name),
            slots: Arc::new(Semaphore::new(limits.max_conns)),
            rng: SystemRandom::new(),
            limits,
            offers: Mutex::new(HashMap::new()),
            inbox: tokio::sync::Notify::new(),
            seen: Mutex::new(HashMap::new()),
            on_presence: RwLock::new(None),
            on_authenticated: RwLock::new(None),
            relay_root: RwLock::new(std::env::temp_dir().join("yon-relay")),
        })
    }

    /// Where relayed files wait. Anything left from an earlier run is
    /// removed: those transfers can't finish any more.
    pub fn set_relay_dir(&self, dir: PathBuf) {
        let _ = std::fs::remove_dir_all(&dir);
        *self.relay_root.write().expect("lock") = dir;
    }

    /// Replace the paired phones. Sessions of removed phones end at once.
    pub fn set_phones(&self, phones: Vec<Phone>) {
        let map: HashMap<_, _> = phones.into_iter().map(|p| (p.id, p)).collect();
        let keep: Vec<[u8; 16]> = map.keys().copied().collect();
        *self.phones.write().expect("lock") = map;
        self.sessions
            .lock()
            .expect("lock")
            .retain(|_, s| match s.try_lock() {
                Ok(s) => keep.contains(&s.phone_id),
                Err(_) => true, // busy: its next request re-checks the phone
            });
        let gone: Vec<Offer> = {
            let mut offers = self.offers.lock().expect("lock");
            let ids: Vec<_> = offers
                .keys()
                .filter(|k| !keep.contains(k))
                .copied()
                .collect();
            ids.iter().filter_map(|k| offers.remove(k)).collect()
        };
        for offer in gone {
            offer.finish(SendOutcome::Failed {
                reason: "The phone was removed".into(),
            });
        }
    }

    /// Offer files to a paired phone. It shows up on the phone's page (now
    /// if the page is open, otherwise next time it opens) for a while.
    pub fn offer(
        &self,
        id: u64,
        phone: [u8; 16],
        files: Vec<OutFile>,
        events: Arc<dyn OfferEvents>,
    ) -> Result<(), String> {
        self.add_offer(id, phone, files, events, None)
    }

    fn add_offer(
        &self,
        id: u64,
        phone: [u8; 16],
        files: Vec<OutFile>,
        events: Arc<dyn OfferEvents>,
        from: Option<String>,
    ) -> Result<(), String> {
        if !self.phones.read().expect("lock").contains_key(&phone) {
            return Err("That phone isn't paired any more".into());
        }
        let mut offer = Offer::new(id, files, events)?;
        offer.from = from;
        {
            let mut offers = self.offers.lock().expect("lock");
            if offers.contains_key(&phone) {
                return Err("Already sending to this phone. Wait or cancel first.".into());
            }
            offer.status(SendStatus::Waiting);
            offers.insert(phone, offer);
        }
        self.inbox.notify_waiters();
        Ok(())
    }

    /// Cancelled on the desktop; the phone learns at its next request.
    pub fn cancel_offer(&self, id: u64) {
        let offer = {
            let mut offers = self.offers.lock().expect("lock");
            let key = offers.iter().find(|(_, o)| o.id == id).map(|(k, _)| *k);
            key.and_then(|k| offers.remove(&k))
        };
        if let Some(o) = offer {
            o.finish(SendOutcome::Cancelled { by_receiver: false });
        }
    }

    /// Phones whose page talked to us recently.
    pub fn online_phones(&self) -> Vec<[u8; 16]> {
        let online_for = self.limits.online_for;
        self.seen
            .lock()
            .expect("lock")
            .iter()
            .filter(|(_, t)| t.elapsed() < online_for)
            .map(|(k, _)| *k)
            .collect()
    }

    /// Called whenever a phone comes online or goes offline.
    pub fn set_presence_listener(&self, f: Arc<dyn Fn() + Send + Sync>) {
        *self.on_presence.write().expect("lock") = Some(f);
    }

    /// Called once per session, with the phone id, after the first request
    /// that opened under the pairing key. Never from `/hello`, a bad tag,
    /// or a replay.
    pub fn set_on_authenticated(&self, f: OnAuthenticated) {
        *self.on_authenticated.write().expect("lock") = Some(f);
    }

    fn presence_changed(&self) {
        let f = self.on_presence.read().expect("lock").clone();
        if let Some(f) = f {
            f();
        }
    }

    fn touch(&self, phone: [u8; 16]) {
        let was_online = self
            .seen
            .lock()
            .expect("lock")
            .insert(phone, Instant::now())
            .is_some_and(|t| t.elapsed() < self.limits.online_for);
        if !was_online {
            self.presence_changed();
        }
    }

    pub fn set_computer_name(&self, name: String) {
        *self.computer_name.write().expect("lock") = name;
    }

    /// Bind the fixed port on all IPv4 interfaces. No fallback: a saved link
    /// on a phone points at this port.
    pub async fn bind(port: u16) -> io::Result<TcpListener> {
        TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await
    }

    /// Accept loop; abort the task to stop. Also sweeps idle sessions.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        let sweeper = {
            let this = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15).min(this.limits.session_idle)).await;
                    this.sweep().await;
                }
            })
        };
        let _stop_sweeper = AbortOnDrop(sweeper);
        loop {
            let (tcp, addr) = match listener.accept().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[yon] link accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            if !is_allowed_peer(&addr) {
                continue;
            }
            let Ok(slot) = self.slots.clone().try_acquire_owned() else {
                continue;
            };
            let this = self.clone();
            tokio::spawn(async move {
                this.handle(tcp, addr).await;
                drop(slot);
            });
        }
    }

    async fn handle(self: Arc<Self>, mut tcp: TcpStream, addr: SocketAddr) {
        let SocketAddr::V4(addr) = addr else { return };
        let req = match read_request(&mut tcp, self.limits.http).await {
            Ok(r) => r,
            Err(e) => {
                let status = match e {
                    HttpError::TooLarge => 413,
                    HttpError::Malformed(_) => 400,
                    HttpError::Timeout | HttpError::Io(_) => return,
                };
                let _ = write_response(&mut tcp, status, "text/plain", &[], b"").await;
                return;
            }
        };
        let (status, ctype, headers, body) = self.respond(&req, *addr.ip()).await;
        let _ = write_response(&mut tcp, status, ctype, &headers, &body).await;
        let _ = tcp.shutdown().await;
    }

    /// Answer one request, whichever way it arrived (LAN socket or relay).
    /// `ip` identifies the phone for rate limits and cooldowns.
    pub async fn respond(&self, req: &Request, ip: Ipv4Addr) -> Response {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/") => (
                200,
                "text/html; charset=utf-8",
                vec![],
                PAGE_HTML.as_bytes().to_vec(),
            ),
            ("GET", "/link.js") => (
                200,
                "text/javascript; charset=utf-8",
                vec![],
                PAGE_JS.as_bytes().to_vec(),
            ),
            ("GET", "/link.css") => (
                200,
                "text/css; charset=utf-8",
                vec![],
                PAGE_CSS.as_bytes().to_vec(),
            ),
            ("GET", "/icon.png") => (200, "image/png", vec![], ICON_PNG.to_vec()),
            ("GET", "/hello") => self.hello(req, ip),
            (
                "POST",
                "/request" | "/chunk" | "/status" | "/done" | "/cancel" | "/inbox" | "/pull"
                | "/peers" | "/offer/accept" | "/offer/decline" | "/offer/done" | "/offer/cancel",
            ) => match self.sealed(req, ip).await {
                Some((ctr, body)) => (
                    200,
                    "application/octet-stream",
                    vec![("X-Yon-Ctr", ctr.to_string())],
                    body,
                ),
                None => not_found(),
            },
            _ => not_found(),
        }
    }

    fn hello(&self, req: &Request, ip: Ipv4Addr) -> Response {
        if !self.allow_hello(ip) {
            return (
                429,
                "text/plain",
                vec![("Retry-After", "60".into())],
                vec![],
            );
        }
        let (Some(pair), Some(nc)) = (
            req.query("p").and_then(unhex::<16>),
            req.query("nc").and_then(unhex::<16>),
        ) else {
            return not_found();
        };
        let Some(phone) = self.phones.read().expect("lock").get(&pair).cloned() else {
            return not_found();
        };
        let mut sessions = self.sessions.lock().expect("lock");
        if sessions.len() >= MAX_SESSIONS {
            return (
                503,
                "text/plain",
                vec![("Retry-After", "30".into())],
                vec![],
            );
        }
        let (mut sid, mut ns) = ([0u8; 16], [0u8; 16]);
        if self.rng.fill(&mut sid).is_err() || self.rng.fill(&mut ns).is_err() {
            return (503, "text/plain", vec![], vec![]);
        }
        sessions.insert(
            sid,
            Arc::new(tokio::sync::Mutex::new(Session {
                phone_id: phone.id,
                phone_name: phone.name.clone(),
                ip,
                key: SessionKey::derive(&phone.key, &ns, &nc),
                inbound: ReplayWindow::default(),
                out: 0,
                last_seen: Instant::now(),
                upload: None,
                authed: false,
            })),
        );
        let name = self.computer_name.read().expect("lock").clone();
        let body = json!({ "sid": hex(&sid), "ns": hex(&ns), "name": name });
        (
            200,
            "application/json",
            vec![],
            body.to_string().into_bytes(),
        )
    }

    // TECH DEBT: per-IP window is bypassable by changing IP on the LAN; the
    // session cap bounds the damage.
    fn allow_hello(&self, ip: Ipv4Addr) -> bool {
        let mut rate = self.hello_rate.lock().expect("lock");
        let now = Instant::now();
        rate.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        let entry = rate.entry(ip).or_insert((now, 0));
        entry.1 += 1;
        entry.1 <= HELLO_PER_MINUTE
    }

    /// Open, dispatch and seal. `None` → identical 404 for every failure
    /// (unknown session, replay, bad tag, removed phone).
    async fn sealed(&self, req: &Request, ip: Ipv4Addr) -> Option<(u64, Vec<u8>)> {
        let sid = req.header("x-yon-sid").and_then(unhex::<16>)?;
        let ctr: u64 = req.header("x-yon-ctr")?.parse().ok()?;
        let session = self.sessions.lock().expect("lock").get(&sid).cloned()?;
        let mut s = session.lock().await;
        if !s.inbound.is_fresh(ctr) || !self.phones.read().expect("lock").contains_key(&s.phone_id)
        {
            return None;
        }
        let route = format!("{} {}", req.method, req.target);
        let plain = s
            .key
            .open(Dir::PhoneToComputer, ctr, &route, &sid, &req.body)?;
        s.inbound.mark(ctr);
        if !s.authed {
            s.authed = true;
            let f = self.on_authenticated.read().expect("lock").clone();
            if let Some(f) = f {
                f(s.phone_id);
            }
        }
        s.last_seen = Instant::now();
        if s.ip != ip {
            s.ip = ip; // phone moved networks mid-session; keep going
        }

        let phone = s.phone_id;
        self.touch(phone);

        let reply: Vec<u8> = match req.path.as_str() {
            "/request" => self
                .on_request(&mut s, &plain)
                .await
                .to_string()
                .into_bytes(),
            "/chunk" => self
                .on_chunk(&mut s, req, &plain)
                .await
                .to_string()
                .into_bytes(),
            "/status" => status(&s).to_string().into_bytes(),
            "/peers" => self.peers(phone).to_string().into_bytes(),
            "/done" => self.on_done(&mut s).to_string().into_bytes(),
            "/cancel" => {
                self.end_upload(&mut s, |saved| RecvOutcome::Cancelled {
                    by_sender: true,
                    saved,
                });
                json!({ "result": "cancelled" }).to_string().into_bytes()
            }
            // WHY: these wait (long-poll, disk reads); release the session
            // so the phone's other requests aren't stuck behind them.
            "/inbox" => {
                drop(s);
                let v = self.on_inbox(phone).await;
                s = session.lock().await;
                v.to_string().into_bytes()
            }
            "/pull" => {
                drop(s);
                let v = self.on_pull(phone, req).await;
                s = session.lock().await;
                v
            }
            path => self.on_offer(phone, path, req).to_string().into_bytes(),
        };
        s.out += 1;
        let sealed = s
            .key
            .seal(Dir::ComputerToPhone, s.out, &route, &sid, &reply);
        Some((s.out, sealed))
    }

    /// Long-poll: the phone's page asks "anything for me?".
    async fn on_inbox(&self, phone: [u8; 16]) -> Value {
        let deadline = tokio::time::Instant::now() + self.limits.inbox_wait;
        loop {
            // Register for wake-ups before looking, so an offer added in
            // between isn't missed.
            let notified = self.inbox.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(offer) = self.offer_json(phone) {
                return json!({ "offer": offer });
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return json!({ "offer": null });
            }
        }
    }

    fn offer_json(&self, phone: [u8; 16]) -> Option<Value> {
        let offers = self.offers.lock().expect("lock");
        let o = offers.get(&phone)?;
        let files: Vec<Value> = o
            .files
            .iter()
            .map(|f| json!({ "name": f.name, "size": f.size }))
            .collect();
        Some(json!({
            "id": o.id,
            "from": o.from.clone().unwrap_or_else(|| self.computer_name.read().expect("lock").clone()),
            "files": files,
            "total": o.total,
            "chunk": CHUNK,
            "accepted": o.accepted,
        }))
    }

    /// `/offer/accept|decline|done|cancel?o=<id>`
    fn on_offer(&self, phone: [u8; 16], path: &str, req: &Request) -> Value {
        let Some(id) = req.query("o").and_then(|v| v.parse::<u64>().ok()) else {
            return json!({ "result": "invalid" });
        };
        let mut offers = self.offers.lock().expect("lock");
        if offers.get(&phone).is_none_or(|o| o.id != id) {
            return json!({ "result": "none" });
        }
        let outcome = match path {
            "/offer/accept" => {
                let o = offers.get_mut(&phone).expect("checked");
                o.accepted = true;
                o.last_activity = Instant::now();
                o.status(SendStatus::Transferring {
                    done: 0,
                    total: o.total,
                });
                return json!({ "result": "accepted", "chunk": CHUNK });
            }
            "/offer/decline" => SendOutcome::Declined,
            "/offer/cancel" => SendOutcome::Cancelled { by_receiver: true },
            "/offer/done" => {
                if !offers.get(&phone).expect("checked").all_served() {
                    return json!({ "result": "incomplete" });
                }
                SendOutcome::Completed
            }
            _ => return json!({ "result": "invalid" }),
        };
        let offer = offers.remove(&phone).expect("checked");
        drop(offers);
        let result = match outcome {
            SendOutcome::Completed => "completed",
            SendOutcome::Declined => "declined",
            _ => "cancelled",
        };
        offer.finish(outcome);
        json!({ "result": result })
    }

    /// `/pull?o=&f=&i=` → tag byte 0 + chunk bytes, or tag 1 + JSON error.
    async fn on_pull(&self, phone: [u8; 16], req: &Request) -> Vec<u8> {
        fn error(result: &str) -> Vec<u8> {
            let mut v = vec![1u8];
            v.extend_from_slice(json!({ "result": result }).to_string().as_bytes());
            v
        }
        let parse = |k| req.query(k).and_then(|v| v.parse::<u64>().ok());
        let (Some(id), Some(f), Some(i)) = (parse("o"), parse("f"), parse("i")) else {
            return error("invalid");
        };
        let f = f as usize;
        let (path, name, offset, len) = {
            let offers = self.offers.lock().expect("lock");
            match offers.get(&phone) {
                Some(o) if o.id == id && o.accepted => match o.chunk_range(f, i) {
                    Some((offset, len)) => (
                        o.files[f].path.clone(),
                        o.files[f].name.clone(),
                        offset,
                        len,
                    ),
                    None => return error("invalid"),
                },
                Some(o) if o.id == id => return error("not_accepted"),
                _ => return error("cancelled"),
            }
        };
        match read_chunk(&path, offset, len).await {
            Ok(data) => {
                if let Some(o) = self.offers.lock().expect("lock").get_mut(&phone) {
                    if o.id == id {
                        o.record(f, i, len);
                    }
                }
                let mut v = Vec::with_capacity(1 + data.len());
                v.push(0);
                v.extend_from_slice(&data);
                v
            }
            Err(e) => {
                let offer = {
                    let mut offers = self.offers.lock().expect("lock");
                    match offers.get(&phone) {
                        Some(o) if o.id == id => offers.remove(&phone),
                        _ => None,
                    }
                };
                if let Some(o) = offer {
                    o.finish(SendOutcome::Failed {
                        reason: format!("Couldn't read {name}: {e}"),
                    });
                }
                error("failed")
            }
        }
    }

    async fn on_request(&self, s: &mut Session, plain: &[u8]) -> Value {
        if s.upload.is_some() {
            return json!({ "result": "busy" });
        }
        let Ok(body) = serde_json::from_slice::<RequestBody>(plain) else {
            return json!({ "result": "invalid", "reason": "bad request" });
        };
        let relay_to = match body.to.as_deref() {
            None => None,
            Some(handle) => match self.relay_target(s.phone_id, handle) {
                Some(t) => Some(t),
                None => return json!({ "result": "unavailable" }),
            },
        };
        if relay_to.is_some()
            && body.files.iter().map(|f| f.size).sum::<u64>() > outbox::PHONE_MAX_BYTES
        {
            return json!({ "result": "too_big" });
        }
        // The name comes from pairing on this computer, not from the phone.
        let request = TransferRequest {
            name: s.phone_name.clone(),
            os: "web".into(),
            // WHY: the phone page never sends folders, and this path writes
            // flat; drop any folder so the Accept dialog shows what happens.
            files: body
                .files
                .into_iter()
                .map(|f| FileMeta { dir: None, ..f })
                .collect(),
        };
        let mut admission =
            match self
                .receiver
                .admit(&request, s.ip, phone_fingerprint(&s.phone_id))
            {
                Ok(a) => a,
                Err(Refusal::Busy) => return json!({ "result": "busy" }),
                Err(Refusal::Declined) => return json!({ "result": "declined" }),
                Err(Refusal::InsufficientSpace) => return json!({ "result": "insufficient_space" }),
                Err(Refusal::Invalid(reason)) => {
                    return json!({ "result": "invalid", "reason": reason })
                }
            };
        let id = admission.incoming.id;
        if relay_to.is_some() {
            // WHY: between two phones this computer only carries the files;
            // the receiving phone accepts (or not) on its own screen.
            let dir = self.relay_root.read().expect("lock").join(id.to_string());
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return json!({ "result": "invalid", "reason": format!("relay folder: {e}") });
            }
            admission.save_dir = dir;
            s.upload = Some(Upload {
                admission,
                file: 0,
                next: 0,
                current: None,
                saved: Vec::new(),
                done_bytes: 0,
                throttle: Throttle::new(),
                relay_to,
            });
            return json!({ "result": "accepted", "chunk": CHUNK });
        }
        let answer = self.receiver.ui().ask(admission.incoming.clone());
        match timeout(self.receiver.limits().accept, answer).await {
            Ok(Ok(Decision::Accept)) => {
                s.upload = Some(Upload {
                    admission,
                    file: 0,
                    next: 0,
                    current: None,
                    saved: Vec::new(),
                    done_bytes: 0,
                    throttle: Throttle::new(),
                    relay_to: None,
                });
                json!({ "result": "accepted", "chunk": CHUNK })
            }
            other => {
                self.receiver.start_cooldown(s.ip);
                let outcome = if other.is_err() {
                    RecvOutcome::TimedOut
                } else {
                    RecvOutcome::Declined
                };
                self.receiver.ui().finished(id, outcome);
                json!({ "result": "declined" })
            }
        }
    }

    async fn on_chunk(&self, s: &mut Session, req: &Request, data: &[u8]) -> Value {
        let (Some(f), Some(i)) = (
            req.query("f").and_then(|v| v.parse::<usize>().ok()),
            req.query("i").and_then(|v| v.parse::<u64>().ok()),
        ) else {
            return json!({ "result": "invalid", "reason": "bad chunk address" });
        };
        let Some(up) = s.upload.as_mut() else {
            return json!({ "result": "none" });
        };
        // Cancelled from the computer since the last chunk?
        let cancelled = tokio::select! {
            biased;
            _ = up.admission.cancel.notified() => true,
            _ = std::future::ready(()) => false,
        };
        if cancelled {
            self.end_upload(s, |saved| RecvOutcome::Cancelled {
                by_sender: false,
                saved,
            });
            return json!({ "result": "cancelled" });
        }
        // Already written (response was lost and the phone retried): ack.
        if f < up.file || (f == up.file && i < up.next) {
            return json!({ "result": "ok", "file": up.file, "next": up.next });
        }
        // A gap: tell the phone where to resume.
        if f > up.file || i > up.next || up.file >= up.admission.incoming.files.len() {
            return json!({ "result": "resume", "file": up.file, "next": up.next });
        }
        let meta = up.admission.incoming.files[f].clone();
        let written = up.current.as_ref().map_or(0, |w| w.written);
        if data.len() > CHUNK || data.len() as u64 > meta.size - written {
            self.end_upload(s, |saved| RecvOutcome::Failed {
                reason: "phone sent more than it announced".into(),
                saved,
            });
            return json!({ "result": "failed", "reason": "size mismatch" });
        }
        match self.write_chunk(s, &meta, data).await {
            Ok(()) => {
                let up = s.upload.as_ref().expect("upload present");
                json!({ "result": "ok", "file": up.file, "next": up.next })
            }
            Err(reason) => {
                self.end_upload(s, |saved| RecvOutcome::Failed {
                    reason: reason.clone(),
                    saved,
                });
                json!({ "result": "failed", "reason": reason })
            }
        }
    }

    async fn write_chunk(
        &self,
        s: &mut Session,
        meta: &crate::server::IncomingFile,
        data: &[u8],
    ) -> Result<(), String> {
        let up = s.upload.as_mut().expect("upload present");
        if up.current.is_none() {
            let reserved = Reserved::claim(&up.admission.save_dir, &meta.name)
                .map_err(|e| format!("cannot create file: {e}"))?;
            let file = reserved
                .open_part()
                .await
                .map_err(|e| format!("cannot create file: {e}"))?;
            up.current = Some(Writing {
                file,
                reserved,
                written: 0,
            });
        }
        let w = up.current.as_mut().expect("writer present");
        w.file
            .write_all(data)
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        w.written += data.len() as u64;
        up.next += 1;
        up.done_bytes += data.len() as u64;
        let (id, total) = (up.admission.incoming.id, up.admission.incoming.total);
        if up.relay_to.is_none() && up.throttle.ready(up.done_bytes == total) {
            self.receiver.ui().progress(id, up.done_bytes, total);
        }
        if w.written == meta.size {
            let Writing {
                mut file, reserved, ..
            } = up.current.take().expect("writer present");
            file.flush()
                .await
                .map_err(|e| format!("write failed: {e}"))?;
            file.sync_all()
                .await
                .map_err(|e| format!("write failed: {e}"))?;
            drop(file);
            let path = reserved
                .commit()
                .map_err(|e| format!("cannot save file: {e}"))?;
            platform::mark_downloaded(&path);
            up.saved.push(path);
            up.file += 1;
            up.next = 0;
        }
        Ok(())
    }

    fn on_done(&self, s: &mut Session) -> Value {
        let Some(up) = s.upload.as_ref() else {
            return json!({ "result": "none" });
        };
        if up.file < up.admission.incoming.files.len() {
            return json!({ "result": "resume", "file": up.file, "next": up.next });
        }
        if let Some(target) = up.relay_to {
            return self.forward(s, target);
        }
        self.end_upload(s, |saved| RecvOutcome::Completed { saved });
        json!({ "result": "completed" })
    }

    /// Finish the session's upload: partial file removed (Reserved drop),
    /// busy slot released (guard drop), UI told exactly once.
    fn end_upload(&self, s: &mut Session, outcome: impl FnOnce(Vec<PathBuf>) -> RecvOutcome) {
        if let Some(up) = s.upload.take() {
            let Upload {
                admission,
                current,
                saved,
                relay_to,
                ..
            } = up;
            drop(current);
            if relay_to.is_some() {
                // Nothing reached the desktop; just drop the relay folder.
                let _ = std::fs::remove_dir_all(&admission.save_dir);
            } else {
                self.receiver
                    .ui()
                    .finished(admission.incoming.id, outcome(saved));
            }
            drop(admission);
        }
    }

    /// Phones this phone can send to: other paired phones with Yon open.
    fn peers(&self, me: [u8; 16]) -> Value {
        let online = self.online_phones();
        let phones = self.phones.read().expect("lock");
        let list: Vec<Value> = online
            .iter()
            .filter(|id| **id != me)
            .filter_map(|id| phones.get(id))
            .map(|p| json!({ "id": phone_handle(&p.id), "name": p.name }))
            .collect();
        json!({ "computer": *self.computer_name.read().expect("lock"), "phones": list })
    }

    fn relay_target(&self, me: [u8; 16], handle: &str) -> Option<[u8; 16]> {
        let online = self.online_phones();
        let phones = self.phones.read().expect("lock");
        let target = phones
            .keys()
            .find(|id| **id != me && phone_handle(id) == handle)
            .copied()?;
        let free = !self.offers.lock().expect("lock").contains_key(&target);
        (online.contains(&target) && free).then_some(target)
    }

    /// Upload finished: offer the stored files to the other phone. The relay
    /// folder goes away when that offer ends, whatever the outcome.
    fn forward(&self, s: &mut Session, target: [u8; 16]) -> Value {
        let up = s.upload.take().expect("checked by caller");
        let dir = up.admission.save_dir.clone();
        let id = RELAY_ID_BASE + up.admission.incoming.id;
        let from = s.phone_name.clone();
        let files: Vec<OutFile> = up
            .saved
            .iter()
            .filter_map(|path| {
                Some(OutFile {
                    size: std::fs::metadata(path).ok()?.len(),
                    name: path.file_name()?.to_string_lossy().into_owned(),
                    path: path.clone(),
                    dir: None,
                })
            })
            .collect();
        drop(up); // frees the one-transfer slot
        match self.add_offer(
            id,
            target,
            files,
            Arc::new(RelayCleanup(dir.clone())),
            Some(from),
        ) {
            Ok(()) => json!({ "result": "completed" }),
            Err(_) => {
                let _ = std::fs::remove_dir_all(&dir);
                json!({ "result": "unavailable" })
            }
        }
    }

    /// Drop idle sessions; an unfinished upload counts as cancelled by the
    /// phone (its page was closed or suspended for too long).
    async fn sweep(&self) {
        let idle = self.limits.session_idle;
        let all: Vec<_> = self
            .sessions
            .lock()
            .expect("lock")
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        for (sid, session) in all {
            let Ok(mut s) = session.try_lock() else {
                continue;
            };
            if s.last_seen.elapsed() >= idle {
                self.end_upload(&mut s, |saved| RecvOutcome::Cancelled {
                    by_sender: true,
                    saved,
                });
                self.sessions.lock().expect("lock").remove(&sid);
            }
        }

        let expired: Vec<(Offer, SendOutcome)> = {
            let mut offers = self.offers.lock().expect("lock");
            let ids: Vec<_> = offers
                .iter()
                .filter_map(|(k, o)| {
                    if !o.accepted && o.created.elapsed() >= self.limits.offer_wait {
                        Some((*k, SendOutcome::TimedOut))
                    } else if o.accepted && o.last_activity.elapsed() >= idle {
                        Some((
                            *k,
                            SendOutcome::Failed {
                                reason: "The phone stopped receiving".into(),
                            },
                        ))
                    } else {
                        None
                    }
                })
                .collect();
            ids.into_iter()
                .filter_map(|(k, out)| offers.remove(&k).map(|o| (o, out)))
                .collect()
        };
        for (offer, outcome) in expired {
            offer.finish(outcome);
        }

        let went_offline = {
            let mut seen = self.seen.lock().expect("lock");
            let before = seen.len();
            seen.retain(|_, t| t.elapsed() < self.limits.online_for);
            seen.len() != before
        };
        if went_offline {
            self.presence_changed();
        }
    }
}

fn status(s: &Session) -> Value {
    match s.upload.as_ref() {
        Some(up) => json!({ "result": "ok", "file": up.file, "next": up.next }),
        None => json!({ "result": "none" }),
    }
}

/// Pairing URL. The secrets sit in the fragment, which browsers never send.
pub fn pairing_url(host: &str, phone: &Phone) -> String {
    format!(
        "http://{host}:{LINK_PORT}/#{}.{}",
        hex(&phone.id),
        hex(&phone.key)
    )
}

/// Where the phone page is published for use through the relay (ADR-003).
pub const PAGE_URL: &str = "https://vactuzx-dot.github.io/Yon/";

/// Pairing URL for the relay page: works on any network. `relay_url` is the
/// wss:// address from settings; the page gets its host after the `@`.
pub fn anywhere_url(phone: &Phone, room: &str, relay_url: &str) -> String {
    let host = relay_url.split("://").nth(1).unwrap_or(relay_url);
    format!(
        "{PAGE_URL}#{}.{}.{room}@{host}",
        hex(&phone.id),
        hex(&phone.key)
    )
}

/// This computer's LAN address as other devices see it, for the IP fallback
/// link (some Android phones can't resolve `.local`). A UDP "connect" only
/// picks the route; no packet is sent.
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

/// QR code for `data` at error correction level H (so a logo can cover the
/// centre) as (modules per side, SVG path of the dark modules, one unit per
/// module). Rendering as a path keeps the webview free of raw markup.
pub fn qr_svg_path(data: &str) -> Option<(usize, String)> {
    let code = qrcode::QrCode::with_error_correction_level(data, qrcode::EcLevel::H).ok()?;
    let n = code.width();
    let colors = code.to_colors();
    let mut path = String::new();
    for y in 0..n {
        let mut x = 0;
        while x < n {
            if colors[y * n + x] == qrcode::Color::Dark {
                let start = x;
                while x < n && colors[y * n + x] == qrcode::Color::Dark {
                    x += 1;
                }
                path.push_str(&format!("M{start} {y}h{}v1h-{}z", x - start, x - start));
            } else {
                x += 1;
            }
        }
    }
    Some((n, path))
}

/// Status, content type, extra headers, body.
pub type Response = (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>);

fn not_found() -> Response {
    (404, "text/plain", vec![], b"Not found".to_vec())
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_fingerprint_is_stable_and_distinct() {
        assert_eq!(phone_fingerprint(&[1; 16]), phone_fingerprint(&[1; 16]));
        assert_ne!(phone_fingerprint(&[1; 16]), phone_fingerprint(&[2; 16]));
    }

    #[test]
    fn anywhere_url_carries_room_and_relay_host_in_the_fragment() {
        let phone = Phone {
            id: [1; 16],
            key: [2; 32],
            name: "p".into(),
        };
        let url = anywhere_url(&phone, &"ab".repeat(32), "wss://relay.example.com");
        let (page, fragment) = url.split_once('#').unwrap();
        assert_eq!(page, PAGE_URL);
        assert!(fragment.ends_with(&format!(".{}@relay.example.com", "ab".repeat(32))));
        assert!(qr_svg_path(&url).is_some(), "fits a QR");
    }

    #[test]
    fn pairing_url_keeps_secrets_in_fragment_and_fits_a_qr() {
        let phone = Phone {
            id: [0xab; 16],
            key: [0xcd; 32],
            name: "p".into(),
        };
        let url = pairing_url("yon-0123456789abcdef.local", &phone);
        let (before, fragment) = url.split_once('#').unwrap();
        assert_eq!(before, "http://yon-0123456789abcdef.local:53421/");
        assert_eq!(fragment, format!("{}.{}", "ab".repeat(16), "cd".repeat(32)));
        let (n, path) = qr_svg_path(&url).unwrap();
        assert!((21..=77).contains(&n), "size {n}");
        assert!(
            path.starts_with("M0 0h7v1h-7z"),
            "finder pattern first: {path:.20}"
        );
    }
}
