//! Sender: connects to a discovered device, asks, streams files.

use crate::identity::{server_name, Fingerprint, Identity};
use crate::protocol::{
    hex, read_frame, write_frame, FileMeta, Frame, ProtoError, TransferRequest, PROTOCOL_VERSION,
};
use crate::transfer::send_body;
use crate::Throttle;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::split;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per candidate address; a black-holed VPN route shouldn't stall the rest.
const TCP_TIMEOUT: Duration = Duration::from_secs(3);
/// Whole "Connecting…" phase, across every candidate address: past this the
/// user sees a failure instead of a spinner that could last ~50 s.
const CONNECTING_LIMIT: Duration = Duration::from_secs(15);
/// Receiver auto-declines after 60s; allow for network slack.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(75);

#[derive(Clone, Debug)]
pub struct Target {
    /// Tried in order until one both connects and proves the pinned key.
    pub addrs: Vec<SocketAddr>,
    pub fingerprint: Fingerprint,
}

#[derive(Clone, Debug)]
pub struct OutFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SendStatus {
    Connecting,
    Waiting,
    Transferring { done: u64, total: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SendOutcome {
    Completed,
    Declined,
    Busy,
    TimedOut,
    Incompatible,
    InsufficientSpace,
    Cancelled { by_receiver: bool },
    Failed { reason: String },
}

fn failed(reason: impl std::fmt::Display) -> SendOutcome {
    SendOutcome::Failed {
        reason: reason.to_string(),
    }
}

/// Run one transfer to completion. `cancel.notify_one()` aborts it; the
/// connection is dropped, which the receiver sees as a sender cancel.
pub async fn send(
    identity: &Identity,
    my_name: &str,
    my_os: &str,
    target: &Target,
    files: &[OutFile],
    cancel: Arc<Notify>,
    on_status: &mut (dyn FnMut(SendStatus) + Send),
) -> SendOutcome {
    let run = run(identity, my_name, my_os, target, files, on_status);
    tokio::select! {
        outcome = run => outcome,
        _ = cancel.notified() => SendOutcome::Cancelled { by_receiver: false },
    }
}

async fn run(
    identity: &Identity,
    my_name: &str,
    my_os: &str,
    target: &Target,
    files: &[OutFile],
    on_status: &mut (dyn FnMut(SendStatus) + Send),
) -> SendOutcome {
    on_status(SendStatus::Connecting);
    let config = match identity.client_config(target.fingerprint) {
        Ok(c) => c,
        Err(e) => return failed(e),
    };
    let tls = match timeout(CONNECTING_LIMIT, connect_any(&target.addrs, config)).await {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return failed(e),
        Err(_) => {
            return failed("couldn't reach the device in time. Check that Yon is open on it and it's on this Wi-Fi")
        }
    };
    let (mut rd, mut wr) = split(tls);

    let request = TransferRequest {
        name: my_name.to_string(),
        os: my_os.to_string(),
        files: files
            .iter()
            .map(|f| FileMeta {
                name: f.name.clone(),
                size: f.size,
            })
            .collect(),
    };
    let total = match request.validate() {
        Ok(t) => t,
        Err(e) => return failed(e),
    };
    if let Err(e) = write_frame(
        &mut wr,
        &Frame::Hello {
            v: PROTOCOL_VERSION,
        },
    )
    .await
    {
        return failed(e);
    }
    if let Err(e) = write_frame(&mut wr, &Frame::Request(request)).await {
        return failed(e);
    }

    on_status(SendStatus::Waiting);
    match timeout(ANSWER_TIMEOUT, read_frame(&mut rd)).await {
        Err(_) => return SendOutcome::TimedOut,
        Ok(Err(e)) => return failed(e),
        Ok(Ok(frame)) => match frame {
            Frame::Accept => {}
            Frame::Decline => return SendOutcome::Declined,
            Frame::Busy => return SendOutcome::Busy,
            Frame::Unsupported { .. } => return SendOutcome::Incompatible,
            Frame::InsufficientSpace => return SendOutcome::InsufficientSpace,
            Frame::Failed { reason } => return failed(reason),
            _ => return failed("unexpected reply"),
        },
    }

    on_status(SendStatus::Transferring { done: 0, total });
    let mut throttle = Throttle::new();
    let mut done = 0u64;
    let upload = async {
        for f in files {
            let digest = send_body(&f.path, f.size, &mut wr, &mut |n| {
                done += n;
                if throttle.ready(false) {
                    on_status(SendStatus::Transferring { done, total });
                }
            })
            .await
            .map_err(|e| format!("{}: {e}", f.name))?;
            write_frame(
                &mut wr,
                &Frame::FileDone {
                    sha256: hex(&digest),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    };
    // WHY: one read future lives across the whole upload. read_frame isn't
    // cancel-safe, so it must never be dropped half-way and re-created.
    let mut upload = pin!(upload);
    let mut reply = pin!(read_frame(&mut rd));
    let mut uploaded = false;
    loop {
        tokio::select! {
            r = &mut upload, if !uploaded => match r {
                Ok(()) => uploaded = true,
                Err(e) => {
                    // The receiver may already have told us why it stopped.
                    return match timeout(Duration::from_secs(2), &mut reply).await {
                        Ok(Ok(frame)) => early_reply(frame),
                        _ => failed(e),
                    };
                }
            },
            f = &mut reply => {
                return match f {
                    Ok(Frame::Done) if uploaded => SendOutcome::Completed,
                    Ok(frame) => early_reply(frame),
                    Err(ProtoError::Io(_)) => failed("receiver disconnected"),
                    Err(e) => failed(e),
                };
            }
        }
    }
}

/// Try each candidate address. A TCP connect that works but fails the pin
/// means some *other* host owns that address on this network — keep going.
async fn connect_any(
    addrs: &[SocketAddr],
    config: std::sync::Arc<tokio_rustls::rustls::ClientConfig>,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let mut last = String::from("could not reach device: no address");
    for addr in addrs {
        let tcp = match timeout(TCP_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                last = format!("could not reach device: {e}");
                continue;
            }
            Err(_) => {
                last = "could not reach device: timed out".into();
                continue;
            }
        };
        let _ = tcp.set_nodelay(true);
        let connector = TlsConnector::from(config.clone());
        match timeout(CONNECT_TIMEOUT, connector.connect(server_name(), tcp)).await {
            Ok(Ok(tls)) => return Ok(tls),
            Ok(Err(e)) => last = format!("secure connection failed: {e}"),
            Err(_) => last = "secure connection timed out".into(),
        }
    }
    Err(last)
}

fn early_reply(frame: Frame) -> SendOutcome {
    match frame {
        Frame::Cancel => SendOutcome::Cancelled { by_receiver: true },
        Frame::Failed { reason } => failed(reason),
        _ => failed("protocol violation"),
    }
}
