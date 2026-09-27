//! Yon Link end to end: a fake phone (raw HTTP + the same session crypto the
//! page uses) talking to a real Link listener on loopback.

use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use yon_lib::identity::Identity;
use yon_lib::link::crypto::{Dir, SessionKey};
use yon_lib::link::{phone_fingerprint, Link, LinkLimits, Phone, CHUNK};
use yon_lib::protocol::{hex, unhex};
use yon_lib::server::{Decision, IncomingRequest, Limits, Receiver, ReceiverUi, RecvOutcome};

#[derive(Clone, Copy)]
enum Mode {
    Accept,
    Decline,
}

struct TestUi {
    mode: Mode,
    asked: AtomicUsize,
    last: Mutex<Option<IncomingRequest>>,
    done: mpsc::UnboundedSender<RecvOutcome>,
}

impl ReceiverUi for TestUi {
    fn ask(&self, req: IncomingRequest) -> oneshot::Receiver<Decision> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(req);
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(match self.mode {
            Mode::Accept => Decision::Accept,
            Mode::Decline => Decision::Decline,
        });
        rx
    }
    fn progress(&self, _: u64, _: u64, _: u64) {}
    fn finished(&self, _: u64, outcome: RecvOutcome) {
        let _ = self.done.send(outcome);
    }
}

struct Env {
    addr: SocketAddr,
    receiver: Arc<Receiver>,
    link: Arc<Link>,
    ui: Arc<TestUi>,
    outcomes: mpsc::UnboundedReceiver<RecvOutcome>,
    phone: Phone,
    recv_dir: PathBuf,
    root: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn setup(tag: &str, mode: Mode) -> Env {
    static N: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "yon-link-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let recv_dir = root.join("recv");
    let identity = Arc::new(Identity::load_or_create(&root.join("id")).unwrap());
    let (tx, outcomes) = mpsc::unbounded_channel();
    let ui = Arc::new(TestUi {
        mode,
        asked: AtomicUsize::new(0),
        last: Mutex::new(None),
        done: tx,
    });
    let receiver = Receiver::new(
        identity,
        Arc::new(RwLock::new(recv_dir.clone())),
        ui.clone(),
        Limits::default(),
    );
    let link = Link::new(receiver.clone(), "Test Mac".into(), LinkLimits::default());
    let phone = Phone {
        id: [0x11; 16],
        key: [0x22; 32],
        name: "Leo's iPhone".into(),
    };
    link.set_phones(vec![phone.clone()]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(link.clone().serve(listener));
    Env {
        addr,
        receiver,
        link,
        ui,
        outcomes,
        phone,
        recv_dir,
        root,
    }
}

/// One raw HTTP request; returns (status, headers, body).
async fn http(
    addr: SocketAddr,
    method: &str,
    target: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut head = format!(
        "{method} {target} HTTP/1.1\r\nHost: t\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8(raw[..split].to_vec()).unwrap();
    let status = head[9..12].parse().unwrap();
    (status, head, raw[split + 4..].to_vec())
}

/// The fake phone: same protocol as web/link.ts.
struct FakePhone {
    addr: SocketAddr,
    sid: [u8; 16],
    key: SessionKey,
    ctr: u64,
}

impl FakePhone {
    async fn hello(addr: SocketAddr, phone: &Phone) -> Self {
        let nc = [0x33u8; 16];
        let (status, _, body) = http(
            addr,
            "GET",
            &format!("/hello?p={}&nc={}", hex(&phone.id), hex(&nc)),
            &[],
            b"",
        )
        .await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_slice(&body).unwrap();
        let sid = unhex::<16>(v["sid"].as_str().unwrap()).unwrap();
        let ns = unhex::<16>(v["ns"].as_str().unwrap()).unwrap();
        Self {
            addr,
            sid,
            key: SessionKey::derive(&phone.key, &ns, &nc),
            ctr: 0,
        }
    }

    /// Sealed call; returns (status, decrypted JSON or Null).
    async fn call(&mut self, method: &str, target: &str, body: &[u8]) -> (u16, Value) {
        self.ctr += 1;
        let ctr = self.ctr;
        self.raw_call(method, target, body, ctr).await
    }

    async fn raw_call(
        &mut self,
        method: &str,
        target: &str,
        body: &[u8],
        ctr: u64,
    ) -> (u16, Value) {
        let route = format!("{method} {target}");
        let sealed = self
            .key
            .seal(Dir::PhoneToComputer, ctr, &route, &self.sid, body);
        let headers = [
            ("X-Yon-Sid", hex(&self.sid)),
            ("X-Yon-Ctr", ctr.to_string()),
        ];
        let (status, head, resp) = http(self.addr, method, target, &headers, &sealed).await;
        if status != 200 {
            return (status, Value::Null);
        }
        let out_ctr: u64 = head
            .lines()
            .find_map(|l| l.strip_prefix("X-Yon-Ctr: "))
            .unwrap()
            .parse()
            .unwrap();
        let plain = self
            .key
            .open(Dir::ComputerToPhone, out_ctr, &route, &self.sid, &resp)
            .unwrap();
        (status, serde_json::from_slice(&plain).unwrap())
    }

    async fn request(&mut self, files: &[(&str, usize)]) -> Value {
        let files: Vec<Value> = files
            .iter()
            .map(|(n, s)| json!({ "name": n, "size": s }))
            .collect();
        self.call(
            "POST",
            "/request",
            json!({ "files": files }).to_string().as_bytes(),
        )
        .await
        .1
    }

    async fn send_file(&mut self, f: usize, data: &[u8]) {
        let chunks: Vec<&[u8]> = if data.is_empty() {
            vec![&[]]
        } else {
            data.chunks(CHUNK).collect()
        };
        for (i, c) in chunks.iter().enumerate() {
            let (s, v) = self.call("POST", &format!("/chunk?f={f}&i={i}"), c).await;
            assert_eq!((s, v["result"].as_str()), (200, Some("ok")), "{v}");
        }
    }
}

fn listing(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

async fn next(env: &mut Env) -> RecvOutcome {
    tokio::time::timeout(Duration::from_secs(10), env.outcomes.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn serves_page_with_security_headers() {
    let env = setup("page", Mode::Accept).await;
    let (status, head, _) = http(env.addr, "GET", "/", &[], b"").await;
    assert_eq!(status, 200);
    assert!(head.contains("Content-Security-Policy: default-src 'self'"));
    assert!(head.contains("Referrer-Policy: no-referrer"));
    assert_eq!(http(env.addr, "GET", "/icon.png", &[], b"").await.0, 200);
    assert_eq!(http(env.addr, "GET", "/link.js", &[], b"").await.0, 200);
    assert_eq!(http(env.addr, "GET", "/link.css", &[], b"").await.0, 200);
    assert_eq!(http(env.addr, "GET", "/nope", &[], b"").await.0, 404);
}

#[tokio::test]
async fn uploads_files_sanitized_and_intact() {
    let mut env = setup("upload", Mode::Accept).await;
    let big: Vec<u8> = (0..(CHUNK * 3 + 12345)).map(|i| (i % 251) as u8).collect();
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    let r = p
        .request(&[("a.txt", 5), ("../../evil.txt", 0), ("big.bin", big.len())])
        .await;
    assert_eq!(r["result"], "accepted", "{r}");
    p.send_file(0, b"hello").await;
    p.send_file(1, b"").await;
    p.send_file(2, &big).await;
    assert_eq!(p.call("POST", "/done", b"").await.1["result"], "completed");
    assert!(matches!(next(&mut env).await, RecvOutcome::Completed { saved } if saved.len() == 3));

    assert_eq!(listing(&env.recv_dir), vec!["a.txt", "big.bin", "evil.txt"]);
    assert_eq!(std::fs::read(env.recv_dir.join("big.bin")).unwrap(), big);
    assert!(!env.root.join("evil.txt").exists());

    let req = env.ui.last.lock().unwrap().clone().unwrap();
    assert_eq!(
        req.sender_name, "Leo's iPhone",
        "name comes from pairing, not the phone"
    );
    assert_eq!(req.sender_os, "web");
    assert_eq!(req.fingerprint, phone_fingerprint(&env.phone.id));
}

#[tokio::test]
async fn strangers_replays_and_tampering_get_404() {
    let env = setup("auth", Mode::Accept).await;
    // Unknown pair id.
    let stranger = Phone {
        id: [0x99; 16],
        key: [0x22; 32],
        name: "x".into(),
    };
    let (s, _, _) = http(
        env.addr,
        "GET",
        &format!("/hello?p={}&nc={}", hex(&stranger.id), hex(&[1u8; 16])),
        &[],
        b"",
    )
    .await;
    assert_eq!(s, 404);
    // Right pair id, wrong key → can't produce a valid tag.
    let mut wrong = FakePhone::hello(
        env.addr,
        &Phone {
            key: [0x44; 32],
            ..env.phone.clone()
        },
    )
    .await;
    assert_eq!(wrong.call("POST", "/status", b"").await.0, 404);
    // Valid session: replayed counter and tampered route are rejected.
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    assert_eq!(p.call("POST", "/status", b"").await.0, 200);
    assert_eq!(p.raw_call("POST", "/status", b"", 1).await.0, 404, "replay");
    p.ctr += 1;
    let ctr = p.ctr;
    let sealed = p
        .key
        .seal(Dir::PhoneToComputer, ctr, "POST /status", &p.sid, b"");
    let headers = [("X-Yon-Sid", hex(&p.sid)), ("X-Yon-Ctr", ctr.to_string())];
    assert_eq!(
        http(env.addr, "POST", "/cancel", &headers, &sealed).await.0,
        404,
        "route bound in AAD"
    );
    // Removing the phone kills its sessions.
    env.link.set_phones(vec![]);
    assert_eq!(p.call("POST", "/status", b"").await.0, 404);
    assert_eq!(env.ui.asked.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn declined_request_writes_nothing() {
    let mut env = setup("decline", Mode::Decline).await;
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    assert_eq!(p.request(&[("x.txt", 3)]).await["result"], "declined");
    assert!(matches!(next(&mut env).await, RecvOutcome::Declined));
    let (s, v) = p.call("POST", "/chunk?f=0&i=0", b"abc").await;
    assert_eq!((s, v["result"].as_str()), (200, Some("none")));
    assert!(listing(&env.recv_dir).is_empty());
}

#[tokio::test]
async fn resumes_after_gaps_and_ignores_duplicates() {
    let mut env = setup("resume", Mode::Accept).await;
    let data: Vec<u8> = vec![7; CHUNK * 2 + 10];
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    p.request(&[("v.mov", data.len())]).await;
    let chunk = |i: usize| data[i * CHUNK..((i + 1) * CHUNK).min(data.len())].to_vec();
    assert_eq!(
        p.call("POST", "/chunk?f=0&i=0", &chunk(0)).await.1["result"],
        "ok"
    );
    // Gap: phone skipped ahead (e.g. suspended) → told where to resume.
    let (_, v) = p.call("POST", "/chunk?f=0&i=2", &chunk(2)).await;
    assert_eq!(
        (v["result"].as_str(), v["next"].as_u64()),
        (Some("resume"), Some(1))
    );
    // Duplicate of an already-written chunk (lost response) → ack, no rewrite.
    assert_eq!(
        p.call("POST", "/chunk?f=0&i=0", &chunk(0)).await.1["result"],
        "ok"
    );
    assert_eq!(p.call("POST", "/status", b"").await.1["next"], 1);
    p.call("POST", "/chunk?f=0&i=1", &chunk(1)).await;
    p.call("POST", "/chunk?f=0&i=2", &chunk(2)).await;
    assert_eq!(p.call("POST", "/done", b"").await.1["result"], "completed");
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Completed { .. }
    ));
    assert_eq!(std::fs::read(env.recv_dir.join("v.mov")).unwrap(), data);
}

#[tokio::test]
async fn computer_cancel_and_phone_cancel_clean_up() {
    let mut env = setup("cancel", Mode::Accept).await;
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    p.request(&[("x.bin", CHUNK * 2)]).await;
    p.call("POST", "/chunk?f=0&i=0", &vec![1; CHUNK]).await;
    let id = env.ui.last.lock().unwrap().as_ref().unwrap().id;
    env.receiver.cancel(id);
    assert_eq!(
        p.call("POST", "/chunk?f=0&i=1", &vec![1; CHUNK]).await.1["result"],
        "cancelled"
    );
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Cancelled {
            by_sender: false,
            ..
        }
    ));
    assert!(
        listing(&env.recv_dir).is_empty(),
        "{:?}",
        listing(&env.recv_dir)
    );

    // The busy slot is free again; now the phone cancels.
    let r = p.request(&[("y.bin", CHUNK * 2)]).await;
    assert_eq!(r["result"], "accepted", "{r}");
    p.call("POST", "/chunk?f=0&i=0", &vec![1; CHUNK]).await;
    assert_eq!(
        p.call("POST", "/cancel", b"").await.1["result"],
        "cancelled"
    );
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Cancelled {
            by_sender: true,
            ..
        }
    ));
    assert!(listing(&env.recv_dir).is_empty());
}

#[tokio::test]
async fn more_bytes_than_announced_fails_and_cleans_up() {
    let mut env = setup("oversize", Mode::Accept).await;
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    p.request(&[("x.txt", 3)]).await;
    let (_, v) = p.call("POST", "/chunk?f=0&i=0", b"abcdef").await;
    assert_eq!(v["result"], "failed");
    assert!(matches!(next(&mut env).await, RecvOutcome::Failed { .. }));
    assert!(listing(&env.recv_dir).is_empty());
}

/// Manual check of the real page in a browser (auto-accepts, never exits):
/// `cargo test --test link -- --ignored serve_page_for_browser --nocapture`
#[tokio::test]
#[ignore]
async fn serve_page_for_browser() {
    let mut env = setup("browser", Mode::Accept).await;
    println!(
        "open http://{}/#{}.{}\nfiles land in {}",
        env.addr,
        hex(&env.phone.id),
        hex(&env.phone.key),
        env.recv_dir.display()
    );
    while let Some(outcome) = env.outcomes.recv().await {
        println!("{outcome:?} → {:?}", listing(&env.recv_dir));
    }
}
