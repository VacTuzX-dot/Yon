//! Receiver: accepts LAN connections, asks the user, streams files to disk.

use crate::identity::{peer_fingerprint, Fingerprint, Identity};
use crate::protocol::{read_frame, write_frame, Frame, ProtoError, PROTOCOL_VERSION};
use crate::sanitize::sanitize_file_name;
use crate::transfer::{recv_body, Reserved, IDLE_TIMEOUT};
use crate::{platform, Throttle};
use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{split, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Notify, Semaphore};
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;

pub const DEFAULT_PORT: u16 = 53420;

#[derive(Clone, Debug)]
pub struct Limits {
    pub handshake: Duration,
    pub accept: Duration,
    pub decline_cooldown: Duration,
    /// Connections allowed to be mid-handshake / mid-request at once.
    pub max_pending_conns: usize,
    /// Keep this much free on the target volume beyond the transfer size.
    pub disk_headroom: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(10),
            accept: Duration::from_secs(60),
            decline_cooldown: Duration::from_secs(30),
            max_pending_conns: 16,
            disk_headroom: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IncomingFile {
    /// Name that will be written (after sanitizing).
    pub name: String,
    pub size: u64,
    pub renamed: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IncomingRequest {
    pub id: u64,
    pub sender_name: String,
    pub sender_os: String,
    pub fingerprint: Fingerprint,
    pub files: Vec<IncomingFile>,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Decline,
}

#[derive(Debug)]
pub enum RecvOutcome {
    Completed {
        saved: Vec<PathBuf>,
    },
    Declined,
    TimedOut,
    Cancelled {
        by_sender: bool,
        saved: Vec<PathBuf>,
    },
    Failed {
        reason: String,
        saved: Vec<PathBuf>,
    },
}

/// What the receiver needs from the app shell (Tauri UI, or a test double).
pub trait ReceiverUi: Send + Sync + 'static {
    /// Show the accept dialog. Dropping the sender counts as Decline.
    fn ask(&self, req: IncomingRequest) -> oneshot::Receiver<Decision>;
    fn progress(&self, id: u64, done: u64, total: u64);
    /// Called exactly once for every request that reached `ask`.
    fn finished(&self, id: u64, outcome: RecvOutcome);
}

pub struct Receiver {
    identity: Arc<Identity>,
    save_dir: Arc<RwLock<PathBuf>>,
    ui: Arc<dyn ReceiverUi>,
    limits: Limits,
    slots: Arc<Semaphore>,
    active: Mutex<Option<(u64, Arc<Notify>)>>,
    cooldown: Mutex<HashMap<Ipv4Addr, Instant>>,
    next_id: AtomicU64,
}

/// Bind the listener on all IPv4 interfaces, falling back to an OS-chosen
/// port if `port` is taken (the real port is advertised over mDNS).
pub async fn bind(port: u16) -> io::Result<TcpListener> {
    match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await
        }
        r => r,
    }
}

/// Only peers on the local network may connect.
pub fn is_allowed_peer(addr: &SocketAddr) -> bool {
    match addr {
        SocketAddr::V4(a) => {
            let ip = a.ip();
            ip.is_private() || ip.is_link_local() || ip.is_loopback()
        }
        // Phase 1 is IPv4-only; also covers IPv4-mapped IPv6 we never bind.
        SocketAddr::V6(_) => false,
    }
}

impl Receiver {
    pub fn new(
        identity: Arc<Identity>,
        save_dir: Arc<RwLock<PathBuf>>,
        ui: Arc<dyn ReceiverUi>,
        limits: Limits,
    ) -> Arc<Self> {
        Arc::new(Self {
            identity,
            save_dir,
            ui,
            slots: Arc::new(Semaphore::new(limits.max_pending_conns)),
            limits,
            active: Mutex::new(None),
            cooldown: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    /// Cancel the running transfer if its id matches.
    pub fn cancel(&self, id: u64) {
        if let Some((active, notify)) = self.active.lock().expect("lock").as_ref() {
            if *active == id {
                notify.notify_one();
            }
        }
    }

    /// Accept loop. Abort the task to stop listening; running transfers
    /// keep their own sockets and finish independently.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        let acceptor = match self.identity.server_config() {
            Ok(cfg) => TlsAcceptor::from(cfg),
            Err(e) => {
                eprintln!("[yon] TLS config error: {e}");
                return;
            }
        };
        loop {
            let (tcp, addr) = match listener.accept().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[yon] accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Cheap rejections before any TLS work.
            if !is_allowed_peer(&addr) {
                continue;
            }
            let Ok(slot) = self.slots.clone().try_acquire_owned() else {
                continue;
            };
            let this = self.clone();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Err(e) = this.handle(tcp, addr, acceptor, slot).await {
                    eprintln!("[yon] connection from {addr} ended: {e}");
                }
            });
        }
    }

    async fn handle(
        self: Arc<Self>,
        tcp: TcpStream,
        addr: SocketAddr,
        acceptor: TlsAcceptor,
        slot: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<(), ProtoError> {
        let _ = tcp.set_nodelay(true);
        let tls = timeout(self.limits.handshake, acceptor.accept(tcp))
            .await
            .map_err(|_| ProtoError::Unexpected("handshake timeout"))??;
        let fingerprint =
            peer_fingerprint(tls.get_ref().1).ok_or(ProtoError::Unexpected("no client cert"))?;
        let (mut rd, mut wr) = split(tls);

        match timed(read_frame(&mut rd)).await? {
            Frame::Hello { v } if v == PROTOCOL_VERSION => {}
            Frame::Hello { .. } => {
                let supported = vec![PROTOCOL_VERSION];
                return write_frame(&mut wr, &Frame::Unsupported { supported }).await;
            }
            _ => return Err(ProtoError::Unexpected("expected hello")),
        }
        let req = match timed(read_frame(&mut rd)).await? {
            Frame::Request(r) => r,
            _ => return Err(ProtoError::Unexpected("expected request")),
        };
        let total = match req.validate() {
            Ok(t) => t,
            Err(e) => {
                let reason = e.to_string();
                write_frame(&mut wr, &Frame::Failed { reason }).await?;
                return Err(e);
            }
        };

        let ip = match addr {
            SocketAddr::V4(a) => *a.ip(),
            SocketAddr::V6(_) => return Err(ProtoError::Unexpected("ipv6")),
        };
        if self.in_cooldown(ip) {
            return write_frame(&mut wr, &Frame::Decline).await;
        }
        let save_dir = self.save_dir.read().expect("lock").clone();
        std::fs::create_dir_all(&save_dir)?;
        let free = platform::free_space(&save_dir).unwrap_or(u64::MAX);
        if free < total.saturating_add(self.limits.disk_headroom) {
            return write_frame(&mut wr, &Frame::InsufficientSpace).await;
        }

        // One transfer at a time (pending dialog counts).
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(Notify::new());
        let busy = {
            let mut active = self.active.lock().expect("lock");
            let busy = active.is_some();
            if !busy {
                *active = Some((id, cancel.clone()));
            }
            busy
        };
        if busy {
            return write_frame(&mut wr, &Frame::Busy).await;
        }
        let _guard = ActiveGuard(&self.active);
        // Past the queue: this connection no longer counts as "pending".
        drop(slot);

        let files: Vec<_> = req
            .files
            .iter()
            .map(|f| {
                let name = sanitize_file_name(&f.name);
                IncomingFile {
                    renamed: name != f.name,
                    name,
                    size: f.size,
                }
            })
            .collect();
        let incoming = IncomingRequest {
            id,
            // Display-only and spoofable; the fingerprint is the real identity.
            sender_name: match crate::sanitize::clean_display(&req.name, 63) {
                n if n.is_empty() => "Unknown device".to_string(),
                n => n,
            },
            sender_os: req.os.clone(),
            fingerprint,
            files: files.clone(),
            total,
        };

        // Wait for the user, but notice if the sender gives up meanwhile:
        // after Request the sender must stay silent, so any read = gone.
        let answer = self.ui.ask(incoming);
        let mut probe = [0u8; 1];
        let decision = tokio::select! {
            d = timeout(self.limits.accept, answer) => match d {
                Ok(Ok(d)) => Some(d),
                Ok(Err(_)) => Some(Decision::Decline),
                Err(_) => None,
            },
            _ = rd.read(&mut probe) => {
                self.ui.finished(id, RecvOutcome::Cancelled { by_sender: true, saved: vec![] });
                return Ok(());
            }
        };
        match decision {
            Some(Decision::Accept) => {}
            Some(Decision::Decline) | None => {
                self.start_cooldown(ip);
                let _ = write_frame(&mut wr, &Frame::Decline).await;
                let outcome = if decision.is_none() {
                    RecvOutcome::TimedOut
                } else {
                    RecvOutcome::Declined
                };
                self.ui.finished(id, outcome);
                return Ok(());
            }
        }
        write_frame(&mut wr, &Frame::Accept).await?;

        let mut saved = Vec::new();
        let mut throttle = Throttle::new();
        let mut done_bytes = 0u64;
        let ui = self.ui.clone();
        for file in &files {
            let mut on_bytes = |n| {
                done_bytes += n;
                if throttle.ready(done_bytes == total) {
                    ui.progress(id, done_bytes, total);
                }
            };
            let result = tokio::select! {
                r = receive_one(&mut rd, &save_dir, file, &mut on_bytes) => r,
                _ = cancel.notified() => {
                    let _ = write_frame(&mut wr, &Frame::Cancel).await;
                    let _ = wr.shutdown().await;
                    // WHY: closing while the sender's bytes sit unread makes the
                    // OS send RST, and Windows then discards our Cancel on the
                    // sender side. Drain until the sender hangs up (bounded).
                    let mut sink = [0u8; 16 * 1024];
                    let _ = timeout(Duration::from_secs(2), async {
                        while matches!(rd.read(&mut sink).await, Ok(n) if n > 0) {}
                    })
                    .await;
                    self.ui.finished(id, RecvOutcome::Cancelled { by_sender: false, saved });
                    return Ok(());
                }
            };
            match result {
                Ok(path) => saved.push(path),
                Err(RecvError::SenderGone) => {
                    self.ui.finished(
                        id,
                        RecvOutcome::Cancelled {
                            by_sender: true,
                            saved,
                        },
                    );
                    return Ok(());
                }
                Err(RecvError::Failed(reason)) => {
                    let _ = write_frame(
                        &mut wr,
                        &Frame::Failed {
                            reason: reason.clone(),
                        },
                    )
                    .await;
                    self.ui.finished(id, RecvOutcome::Failed { reason, saved });
                    return Ok(());
                }
            }
        }
        ui.progress(id, total, total);
        let _ = write_frame(&mut wr, &Frame::Done).await;
        let _ = wr.shutdown().await;
        self.ui.finished(id, RecvOutcome::Completed { saved });
        Ok(())
    }

    fn in_cooldown(&self, ip: Ipv4Addr) -> bool {
        let mut map = self.cooldown.lock().expect("lock");
        let now = Instant::now();
        map.retain(|_, until| *until > now);
        map.contains_key(&ip)
    }

    // TECH DEBT: per-IP cooldown is bypassable by changing IP on the LAN;
    // the real fix is Phase 2 "trusted devices only" mode.
    fn start_cooldown(&self, ip: Ipv4Addr) {
        let until = Instant::now() + self.limits.decline_cooldown;
        self.cooldown.lock().expect("lock").insert(ip, until);
    }
}

/// Clears the "busy" slot however `handle` exits.
struct ActiveGuard<'a>(&'a Mutex<Option<(u64, Arc<Notify>)>>);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut a) = self.0.lock() {
            *a = None;
        }
    }
}

enum RecvError {
    SenderGone,
    Failed(String),
}

async fn receive_one<R: tokio::io::AsyncRead + Unpin>(
    rd: &mut R,
    dir: &std::path::Path,
    file: &IncomingFile,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<PathBuf, RecvError> {
    use crate::transfer::BodyError;
    let fail = |what: &str, e: &dyn std::fmt::Display| RecvError::Failed(format!("{what}: {e}"));

    let reserved = Reserved::claim(dir, &file.name).map_err(|e| fail("cannot create file", &e))?;
    let mut part = reserved
        .open_part()
        .await
        .map_err(|e| fail("cannot create file", &e))?;
    let digest = match recv_body(rd, &mut part, file.size, progress).await {
        Ok(d) => d,
        Err(BodyError::Truncated) => return Err(RecvError::SenderGone),
        Err(e) => return Err(fail("receive failed", &e)),
    };
    // Anything but FileDone here also catches a sender that sent more bytes
    // than it declared: the surplus doesn't parse as a frame.
    let claimed = match timed(read_frame(rd)).await {
        Ok(Frame::FileDone { sha256 }) => sha256,
        Ok(_) => return Err(RecvError::Failed("protocol violation".into())),
        Err(ProtoError::Io(e)) if crate::transfer::is_disconnect(&e) => {
            return Err(RecvError::SenderGone)
        }
        Err(e) => return Err(fail("protocol violation", &e)),
    };
    if claimed != crate::protocol::hex(&digest) {
        return Err(RecvError::Failed(format!(
            "checksum mismatch for {}",
            file.name
        )));
    }
    part.sync_all()
        .await
        .map_err(|e| fail("write failed", &e))?;
    drop(part);
    let path = reserved
        .commit()
        .map_err(|e| fail("cannot save file", &e))?;
    platform::mark_downloaded(&path);
    Ok(path)
}

async fn timed<T>(
    fut: impl std::future::Future<Output = Result<T, ProtoError>>,
) -> Result<T, ProtoError> {
    timeout(IDLE_TIMEOUT, fut)
        .await
        .map_err(|_| ProtoError::Unexpected("timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(a: [u8; 4]) -> SocketAddr {
        SocketAddr::from((a, 1))
    }

    #[test]
    fn allows_only_local_ranges() {
        for ok in [
            [10, 0, 0, 1],
            [172, 16, 0, 1],
            [172, 31, 9, 9],
            [192, 168, 1, 5],
            [169, 254, 3, 4],
            [127, 0, 0, 1],
        ] {
            assert!(is_allowed_peer(&v4(ok)), "{ok:?}");
        }
        for bad in [
            [8, 8, 8, 8],
            [172, 32, 0, 1],
            [100, 64, 0, 1],
            [1, 1, 1, 1],
            [0, 0, 0, 0],
        ] {
            assert!(!is_allowed_peer(&v4(bad)), "{bad:?}");
        }
        assert!(!is_allowed_peer(&"[::1]:1".parse().unwrap()));
    }

    #[tokio::test]
    async fn bind_falls_back_when_port_taken() {
        let first = bind(0).await.unwrap();
        let port = first.local_addr().unwrap().port();
        let second = bind(port).await.unwrap();
        assert_ne!(second.local_addr().unwrap().port(), port);
    }
}
