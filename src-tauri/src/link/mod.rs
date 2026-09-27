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

use crate::identity::Fingerprint;
use crate::protocol::{hex, unhex, FileMeta, TransferRequest};
use crate::server::{is_allowed_peer, Admission, Decision, Receiver, RecvOutcome, Refusal};
use crate::transfer::Reserved;
use crate::{platform, Throttle};
use crypto::{Dir, SessionKey};
use http::{read_request, write_response, HttpError, Request};
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

pub struct Link {
    receiver: Arc<Receiver>,
    phones: RwLock<HashMap<[u8; 16], Phone>>,
    sessions: Mutex<HashMap<[u8; 16], Arc<tokio::sync::Mutex<Session>>>>,
    hello_rate: Mutex<HashMap<Ipv4Addr, (Instant, u32)>>,
    computer_name: RwLock<String>,
    slots: Arc<Semaphore>,
    rng: SystemRandom,
    limits: LinkLimits,
}

struct Session {
    phone_id: [u8; 16],
    phone_name: String,
    ip: Ipv4Addr,
    key: SessionKey,
    last_in: u64,
    out: u64,
    last_seen: Instant,
    upload: Option<Upload>,
}

struct Upload {
    admission: Admission,
    file: usize,
    next: u64,
    current: Option<Writing>,
    saved: Vec<PathBuf>,
    done_bytes: u64,
    throttle: Throttle,
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
        })
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
        let (status, ctype, headers, body): (u16, &str, Vec<(&str, String)>, Vec<u8>) =
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
                ("GET", "/hello") => self.hello(&req, *addr.ip()),
                ("POST", "/request" | "/chunk" | "/status" | "/done" | "/cancel") => {
                    match self.sealed(&req, *addr.ip()).await {
                        Some((ctr, body)) => (
                            200,
                            "application/octet-stream",
                            vec![("X-Yon-Ctr", ctr.to_string())],
                            body,
                        ),
                        None => not_found(),
                    }
                }
                _ => not_found(),
            };
        let _ = write_response(&mut tcp, status, ctype, &headers, &body).await;
        let _ = tcp.shutdown().await;
    }

    fn hello(
        &self,
        req: &Request,
        ip: Ipv4Addr,
    ) -> (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>) {
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
                last_in: 0,
                out: 0,
                last_seen: Instant::now(),
                upload: None,
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
        if ctr <= s.last_in || !self.phones.read().expect("lock").contains_key(&s.phone_id) {
            return None;
        }
        let route = format!("{} {}", req.method, req.target);
        let plain = s
            .key
            .open(Dir::PhoneToComputer, ctr, &route, &sid, &req.body)?;
        s.last_in = ctr;
        s.last_seen = Instant::now();
        if s.ip != ip {
            s.ip = ip; // phone moved networks mid-session; keep going
        }

        let reply = match req.path.as_str() {
            "/request" => self.on_request(&mut s, &plain).await,
            "/chunk" => self.on_chunk(&mut s, req, &plain).await,
            "/status" => status(&s),
            "/done" => self.on_done(&mut s),
            "/cancel" => {
                self.end_upload(&mut s, |saved| RecvOutcome::Cancelled {
                    by_sender: true,
                    saved,
                });
                json!({ "result": "cancelled" })
            }
            _ => return None,
        };
        s.out += 1;
        let sealed = s.key.seal(
            Dir::ComputerToPhone,
            s.out,
            &route,
            &sid,
            reply.to_string().as_bytes(),
        );
        Some((s.out, sealed))
    }

    async fn on_request(&self, s: &mut Session, plain: &[u8]) -> Value {
        if s.upload.is_some() {
            return json!({ "result": "busy" });
        }
        let Ok(body) = serde_json::from_slice::<RequestBody>(plain) else {
            return json!({ "result": "invalid", "reason": "bad request" });
        };
        // The name comes from pairing on this computer, not from the phone.
        let request = TransferRequest {
            name: s.phone_name.clone(),
            os: "web".into(),
            files: body.files,
        };
        let admission = match self
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
        if up.throttle.ready(up.done_bytes == total) {
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
                ..
            } = up;
            drop(current);
            self.receiver
                .ui()
                .finished(admission.incoming.id, outcome(saved));
            drop(admission);
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
    }
}

fn status(s: &Session) -> Value {
    match s.upload.as_ref() {
        Some(up) => json!({ "result": "ok", "file": up.file, "next": up.next }),
        None => json!({ "result": "none" }),
    }
}

fn not_found() -> (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>) {
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
}
