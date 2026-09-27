//! Reach this computer's Yon Link from anywhere through a relay (ADR-003).
//!
//! One outbound WebSocket to `<relay>/computer`. The first message is the room
//! secret; the relay answers with the room id, which must equal SHA-256 of the
//! secret. After that every binary frame carries one phone request, answered by
//! the same `Link::respond` the LAN listener uses — the relay only ever sees
//! sealed bytes.
//!
//! Frame from the relay: phone id u32 ‖ request id u32 ‖ head length u16 ‖
//! head JSON `{"m": method, "t": target, "h": [[name, value], …]}` ‖ body.
//! Reply: phone id ‖ request id ‖ head length ‖ `{"s": status, "h": […]}` ‖ body.

use super::Link;
use crate::link::http::Request;
use crate::protocol::hex;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Semaphore};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const MAX_HEAD: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
/// Requests handled at once for all phones (long-polls count).
const IN_FLIGHT: usize = 64;
const PING_EVERY: Duration = Duration::from_secs(25);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RemoteStatus {
    Connecting,
    Connected,
    Error { message: String },
}

/// Room the relay should confirm for `secret`.
pub fn room_id(secret: &[u8; 32]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, secret).as_ref())
}

/// Phones behind the relay have no IP. Each relay connection gets its own
/// address in 240.0.0.0/4 (reserved, never on a LAN) so per-phone rate
/// limits and cooldowns keep working.
fn pseudo_ip(phone: u32) -> Ipv4Addr {
    Ipv4Addr::from(0xF000_0000 | (phone & 0x0FFF_FFFF))
}

#[derive(Deserialize)]
struct Head {
    m: String,
    t: String,
    #[serde(default)]
    h: Vec<(String, String)>,
}

/// Answer one relayed frame; `None` for anything malformed (dropped).
pub async fn handle_frame(link: &Link, frame: &[u8], max_body: usize) -> Option<Vec<u8>> {
    let phone = u32::from_be_bytes(frame.get(0..4)?.try_into().ok()?);
    let head_len = u16::from_be_bytes(frame.get(8..10)?.try_into().ok()?) as usize;
    if head_len > MAX_HEAD {
        return None;
    }
    let head: Head = serde_json::from_slice(frame.get(10..10 + head_len)?).ok()?;
    let body = frame.get(10 + head_len..)?;
    if body.len() > max_body
        || head.h.len() > MAX_HEADERS
        || !matches!(head.m.as_str(), "GET" | "POST")
        || !head.t.starts_with('/')
        || head.t.len() > 2048
    {
        return None;
    }
    let req = Request::from_parts(head.m, head.t, head.h, body.to_vec());
    let (status, ctype, headers, body) = link.respond(&req, pseudo_ip(phone)).await;
    let mut h: Vec<(String, String)> = headers
        .into_iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect();
    h.push(("content-type".into(), ctype.into()));
    let head = serde_json::to_vec(&serde_json::json!({ "s": status, "h": h })).ok()?;
    let mut out = Vec::with_capacity(10 + head.len() + body.len());
    out.extend_from_slice(&frame[..8]); // phone id + request id
    out.extend_from_slice(&(head.len() as u16).to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(&body);
    Some(out)
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Keep a connection to the relay open until the task is aborted,
/// reconnecting with backoff. `relay` is e.g. `wss://relay.example.com`.
pub async fn run(
    link: Arc<Link>,
    relay: String,
    secret: [u8; 32],
    max_body: usize,
    on_status: impl Fn(RemoteStatus) + Send + Sync + 'static,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        on_status(RemoteStatus::Connecting);
        let started = std::time::Instant::now();
        let err = session(&link, &relay, &secret, max_body, &on_status)
            .await
            .unwrap_err();
        eprintln!("[yon] relay: {err}");
        on_status(RemoteStatus::Error { message: err });
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1); // it was working; retry soon
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

type Ws = tokio_tungstenite::WebSocketStream<Box<dyn Io>>;

async fn connect(relay: &str) -> Result<Ws, String> {
    let url = format!("{}/computer", relay.trim_end_matches('/'));
    let req = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad relay URL: {e}"))?;
    let uri = req.uri().clone();
    let host = uri.host().ok_or("relay URL has no host")?.to_string();
    let tls = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err("relay URL must start with wss:// (or ws:// for testing)".into()),
    };
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let tcp = timeout(
        Duration::from_secs(10),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| "relay didn't answer".to_string())?
    .map_err(|e| format!("can't reach relay: {e}"))?;
    let stream: Box<dyn Io> = if tls {
        use rustls_platform_verifier::BuilderVerifierExt;
        // WHY: the OS trust store for the relay's public certificate, with
        // ring passed explicitly (no process-wide default provider is set).
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_platform_verifier())
        .map_err(|e| format!("TLS setup: {e}"))?
        .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host)
            .map_err(|_| "bad relay host name".to_string())?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .map_err(|e| format!("TLS with relay failed: {e}"))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };
    let (ws, _) = timeout(
        Duration::from_secs(10),
        tokio_tungstenite::client_async(req, stream),
    )
    .await
    .map_err(|_| "relay handshake timed out".to_string())?
    .map_err(|e| format!("relay handshake failed: {e}"))?;
    Ok(ws)
}

/// One connection: prove the room, then serve frames until it drops.
/// Always ends with an error (the reason it dropped).
async fn session(
    link: &Arc<Link>,
    relay: &str,
    secret: &[u8; 32],
    max_body: usize,
    on_status: &(impl Fn(RemoteStatus) + Send + Sync),
) -> Result<(), String> {
    let mut ws = connect(relay).await?;
    ws.send(Message::Text(hex(secret).into()))
        .await
        .map_err(|e| format!("relay: {e}"))?;
    let expected = room_id(secret);
    match timeout(Duration::from_secs(10), ws.next()).await {
        Ok(Some(Ok(Message::Text(room)))) if room.as_str() == expected => {}
        // WHY: a relay confirming another room would route our phones elsewhere.
        Ok(Some(Ok(_))) => return Err("relay confirmed the wrong room".into()),
        _ => return Err("relay didn't confirm the room".into()),
    }
    on_status(RemoteStatus::Connected);

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(IN_FLIGHT);
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        loop {
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = ping.tick() => Message::Ping(Vec::new().into()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let slots = Arc::new(Semaphore::new(IN_FLIGHT));
    let result = loop {
        let msg = match stream.next().await {
            Some(Ok(m)) => m,
            Some(Err(e)) => break Err(format!("relay: {e}")),
            None => break Err("relay closed the connection".into()),
        };
        match msg {
            Message::Binary(frame) => {
                let Ok(slot) = slots.clone().try_acquire_owned() else {
                    continue; // overloaded: drop, the phone retries
                };
                let (link, tx) = (link.clone(), tx.clone());
                tokio::spawn(async move {
                    if let Some(reply) = handle_frame(&link, &frame, max_body).await {
                        let _ = tx.send(Message::Binary(reply.into())).await;
                    }
                    drop(slot);
                });
            }
            Message::Close(_) => break Err("relay closed the connection".into()),
            _ => {}
        }
    };
    writer.abort();
    result
}
