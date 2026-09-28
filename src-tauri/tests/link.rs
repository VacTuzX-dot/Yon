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
use yon_lib::client::{OutFile, SendOutcome, SendStatus};
use yon_lib::identity::Identity;
use yon_lib::link::crypto::{Dir, SessionKey};
use yon_lib::link::outbox::OfferEvents;
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
    setup_with(tag, mode, LinkLimits::default()).await
}

async fn setup_with(tag: &str, mode: Mode, limits: LinkLimits) -> Env {
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
    let link = Link::new(receiver.clone(), "Test Mac".into(), limits);
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
        let (status, plain) = self.raw_bytes(method, target, body, ctr).await;
        match plain {
            Some(p) => (status, serde_json::from_slice(&p).unwrap()),
            None => (status, Value::Null),
        }
    }

    /// Sealed call returning the decrypted reply bytes as they are.
    async fn raw_bytes(
        &self,
        method: &str,
        target: &str,
        body: &[u8],
        ctr: u64,
    ) -> (u16, Option<Vec<u8>>) {
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
            return (status, None);
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
        (status, Some(plain))
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
    // A second phone, to try phone → phone in another tab.
    let b = Phone {
        id: [0x44; 16],
        key: [0x55; 32],
        name: "Second phone".into(),
    };
    env.link.set_phones(vec![env.phone.clone(), b.clone()]);
    env.link.set_relay_dir(env.root.join("relay"));
    println!(
        "second phone: http://{}/#{}.{}",
        env.addr,
        hex(&b.id),
        hex(&b.key)
    );
    // Through a relay too, if one is running (e.g. `bun relay/relay.ts`).
    if let Ok(relay) = std::env::var("YON_TEST_RELAY") {
        let secret = [0x5a; 32];
        tokio::spawn(yon_lib::link::remote::run(
            env.link.clone(),
            relay.clone(),
            secret,
            CHUNK + 64,
            |s| println!("relay: {s:?}"),
        ));
        let host = relay
            .split("://")
            .nth(1)
            .unwrap_or(&relay)
            .trim_end_matches('/');
        println!(
            "via relay: http://{}/#{}.{}.{}@{}",
            env.addr,
            hex(&env.phone.id),
            hex(&env.phone.key),
            yon_lib::link::remote::room_id(&secret),
            host
        );
    }
    // Computer → phone: keep offering two files; each outcome is printed.
    let big: Vec<u8> = (0..(CHUNK * 2 + 4321)).map(|i| (i % 251) as u8).collect();
    let src = env.root.join("send");
    let files = vec![
        out_file(&src, "hello.txt", b"hello from the computer\n"),
        out_file(&src, "pattern.bin", &big),
    ];
    let (link, phone) = (env.link.clone(), env.phone.id);
    tokio::spawn(async move {
        for id in 1..=u64::MAX {
            let (ev, done) = events();
            if link.offer(id, phone, files.clone(), ev.clone()).is_ok() {
                println!("offer {id}: {:?}", done.await);
                println!("  events: {}", ev.log.lock().unwrap().join(" | "));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    while let Some(outcome) = env.outcomes.recv().await {
        println!("{outcome:?} → {:?}", listing(&env.recv_dir));
    }
}

// ---------- computer → phone ----------

#[derive(Default)]
struct Events {
    log: Mutex<Vec<String>>,
    done: Mutex<Option<oneshot::Sender<SendOutcome>>>,
}

impl OfferEvents for Events {
    fn status(&self, s: SendStatus) {
        self.log.lock().unwrap().push(format!("{s:?}"));
    }
    fn finished(&self, o: SendOutcome) {
        self.log.lock().unwrap().push(format!("{o:?}"));
        if let Some(tx) = self.done.lock().unwrap().take() {
            let _ = tx.send(o);
        }
    }
}

fn events() -> (Arc<Events>, oneshot::Receiver<SendOutcome>) {
    let (tx, rx) = oneshot::channel();
    let e = Arc::new(Events::default());
    *e.done.lock().unwrap() = Some(tx);
    (e, rx)
}

fn out_file(dir: &Path, name: &str, data: &[u8]) -> OutFile {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, data).unwrap();
    OutFile {
        path,
        name: name.into(),
        size: data.len() as u64,
    }
}

async fn finished(rx: oneshot::Receiver<SendOutcome>) -> SendOutcome {
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .unwrap()
        .unwrap()
}

impl FakePhone {
    /// Pull one chunk with an explicit counter (so tests can reorder).
    async fn pull(&self, o: u64, f: usize, i: u64, ctr: u64) -> Result<Vec<u8>, Value> {
        let (status, plain) = self
            .raw_bytes("POST", &format!("/pull?o={o}&f={f}&i={i}"), b"", ctr)
            .await;
        assert_eq!(status, 200);
        let plain = plain.unwrap();
        match plain[0] {
            0 => Ok(plain[1..].to_vec()),
            _ => Err(serde_json::from_slice(&plain[1..]).unwrap()),
        }
    }
}

#[tokio::test]
async fn phone_downloads_offer_in_parallel_and_out_of_order() {
    let env = setup("offer", Mode::Accept).await;
    let big: Vec<u8> = (0..(CHUNK * 2 + 777)).map(|i| (i % 253) as u8).collect();
    let src = env.root.join("send");
    let files = vec![
        out_file(&src, "empty.txt", b""),
        out_file(&src, "big.bin", &big),
    ];
    let (ev, done) = events();
    env.link.offer(7, env.phone.id, files, ev.clone()).unwrap();

    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    let offer = p.call("POST", "/inbox", b"").await.1["offer"].clone();
    assert_eq!(offer["id"], 7);
    assert_eq!(offer["from"], "Test Mac");
    assert_eq!(offer["files"][1]["size"], big.len());
    assert!(env.link.online_phones().contains(&env.phone.id));

    // Not accepted yet: nothing to pull.
    p.ctr += 1;
    assert_eq!(
        p.pull(7, 1, 0, p.ctr).await.unwrap_err()["result"],
        "not_accepted"
    );
    assert_eq!(
        p.call("POST", "/offer/accept?o=7", b"").await.1["result"],
        "accepted"
    );

    // Counters used out of order and requests in parallel, like the page.
    let base = p.ctr;
    p.ctr += 4;
    let (c2, c1, c0, e0) = tokio::join!(
        p.pull(7, 1, 2, base + 4),
        p.pull(7, 1, 1, base + 2),
        p.pull(7, 1, 0, base + 3),
        p.pull(7, 0, 0, base + 1),
    );
    let got = [c0.unwrap(), c1.unwrap(), c2.unwrap()].concat();
    assert_eq!(got, big);
    assert!(e0.unwrap().is_empty());
    // A retried chunk is fine; out-of-range and replayed counters are not.
    p.ctr += 1;
    assert_eq!(p.pull(7, 1, 2, p.ctr).await.unwrap().len(), 777);
    p.ctr += 1;
    assert_eq!(
        p.pull(7, 1, 3, p.ctr).await.unwrap_err()["result"],
        "invalid"
    );
    let (status, _) = p
        .raw_bytes("POST", "/pull?o=7&f=1&i=0", b"", base + 3)
        .await;
    assert_eq!(status, 404, "replayed counter");

    assert_eq!(
        p.call("POST", "/offer/done?o=7", b"").await.1["result"],
        "completed"
    );
    assert_eq!(finished(done).await, SendOutcome::Completed);
    let log = ev.log.lock().unwrap().join(" | ");
    assert!(log.starts_with("Waiting | Transferring { done: 0"), "{log}");
    assert!(
        log.contains(&format!("done: {}, total: {}", big.len(), big.len())),
        "{log}"
    );
}

#[tokio::test]
async fn inbox_waits_for_an_offer_and_done_needs_every_chunk() {
    let limits = LinkLimits {
        inbox_wait: Duration::from_secs(5),
        ..LinkLimits::default()
    };
    let env = setup_with("inbox", Mode::Accept, limits).await;
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    let (ev, done) = events();
    let files = vec![out_file(&env.root.join("s"), "a.txt", b"hello")];
    let link = env.link.clone();
    let phone = env.phone.id;
    let adder = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        link.offer(1, phone, files, ev).unwrap();
    });
    let t = std::time::Instant::now();
    let offer = p.call("POST", "/inbox", b"").await.1["offer"].clone();
    adder.await.unwrap();
    assert_eq!(offer["id"], 1);
    assert!(t.elapsed() < Duration::from_secs(3), "woken, not timed out");

    p.call("POST", "/offer/accept?o=1", b"").await;
    assert_eq!(
        p.call("POST", "/offer/done?o=1", b"").await.1["result"],
        "incomplete"
    );
    p.ctr += 1;
    assert_eq!(p.pull(1, 0, 0, p.ctr).await.unwrap(), b"hello");
    assert_eq!(
        p.call("POST", "/offer/done?o=1", b"").await.1["result"],
        "completed"
    );
    assert_eq!(finished(done).await, SendOutcome::Completed);
}

#[tokio::test]
async fn offers_can_be_declined_or_cancelled_from_either_side() {
    let limits = LinkLimits {
        inbox_wait: Duration::from_millis(200),
        ..LinkLimits::default()
    };
    let env = setup_with("offer-end", Mode::Accept, limits).await;
    let src = env.root.join("s");
    let mut p = FakePhone::hello(env.addr, &env.phone).await;

    let (ev, done) = events();
    env.link
        .offer(1, env.phone.id, vec![out_file(&src, "a", b"1")], ev)
        .unwrap();
    let (e2, _) = events();
    assert!(
        env.link
            .offer(2, env.phone.id, vec![out_file(&src, "b", b"2")], e2)
            .is_err(),
        "one offer per phone"
    );
    assert_eq!(
        p.call("POST", "/offer/decline?o=1", b"").await.1["result"],
        "declined"
    );
    assert_eq!(finished(done).await, SendOutcome::Declined);
    assert!(p.call("POST", "/inbox", b"").await.1["offer"].is_null());

    let (ev, done) = events();
    env.link
        .offer(3, env.phone.id, vec![out_file(&src, "c", b"3")], ev)
        .unwrap();
    p.call("POST", "/offer/accept?o=3", b"").await;
    env.link.cancel_offer(3);
    assert_eq!(
        finished(done).await,
        SendOutcome::Cancelled { by_receiver: false }
    );
    p.ctr += 1;
    assert_eq!(
        p.pull(3, 0, 0, p.ctr).await.unwrap_err()["result"],
        "cancelled"
    );

    let (ev, done) = events();
    env.link
        .offer(4, env.phone.id, vec![out_file(&src, "d", b"4")], ev)
        .unwrap();
    assert_eq!(
        p.call("POST", "/offer/cancel?o=4", b"").await.1["result"],
        "cancelled"
    );
    assert_eq!(
        finished(done).await,
        SendOutcome::Cancelled { by_receiver: true }
    );

    let (ev, _) = events();
    assert!(
        env.link
            .offer(5, [0x99; 16], vec![out_file(&src, "e", b"5")], ev)
            .is_err(),
        "unknown phone"
    );
}

#[tokio::test]
async fn unanswered_offers_time_out_and_removed_phones_end_theirs() {
    let limits = LinkLimits {
        offer_wait: Duration::from_millis(200),
        session_idle: Duration::from_millis(300),
        ..LinkLimits::default()
    };
    let env = setup_with("offer-expire", Mode::Accept, limits).await;
    let src = env.root.join("s");
    let (ev, done) = events();
    env.link
        .offer(1, env.phone.id, vec![out_file(&src, "a", b"1")], ev)
        .unwrap();
    assert_eq!(finished(done).await, SendOutcome::TimedOut);

    let (ev, done) = events();
    env.link
        .offer(2, env.phone.id, vec![out_file(&src, "b", b"2")], ev)
        .unwrap();
    env.link.set_phones(vec![]);
    assert!(matches!(finished(done).await, SendOutcome::Failed { .. }));
}

// ---------- phone → phone through the computer ----------

#[tokio::test]
async fn phones_send_to_each_other_through_the_computer() {
    let limits = LinkLimits {
        inbox_wait: Duration::from_millis(200),
        ..LinkLimits::default()
    };
    let mut env = setup_with("relay", Mode::Accept, limits).await;
    let relay = env.root.join("relay");
    env.link.set_relay_dir(relay.clone());
    let b = Phone {
        id: [0x44; 16],
        key: [0x55; 32],
        name: "Ploy's Pixel".into(),
    };
    env.link.set_phones(vec![env.phone.clone(), b.clone()]);

    let mut pa = FakePhone::hello(env.addr, &env.phone).await;
    let mut pb = FakePhone::hello(env.addr, &b).await;

    // B hasn't opened its page yet: not a peer, can't be sent to.
    assert_eq!(pa.call("POST", "/peers", b"").await.1["phones"], json!([]));
    assert!(pb.call("POST", "/inbox", b"").await.1["offer"].is_null());
    let peers = pa.call("POST", "/peers", b"").await.1;
    assert_eq!(peers["computer"], "Test Mac");
    assert_eq!(peers["phones"][0]["name"], "Ploy's Pixel");
    let handle = peers["phones"][0]["id"].as_str().unwrap().to_string();
    assert_ne!(
        handle,
        hex(&b.id),
        "the pairing id is never shown to other phones"
    );
    assert_eq!(
        pb.call("POST", "/peers", b"").await.1["phones"][0]["name"],
        "Leo's iPhone"
    );

    let data: Vec<u8> = (0..(CHUNK + 10)).map(|i| (i % 199) as u8).collect();
    let req = json!({ "files": [{ "name": "clip.mov", "size": data.len() }], "to": handle });
    let r = pa
        .call("POST", "/request", req.to_string().as_bytes())
        .await
        .1;
    assert_eq!(r["result"], "accepted", "{r}");
    pa.send_file(0, &data).await;
    assert_eq!(pa.call("POST", "/done", b"").await.1["result"], "completed");
    assert_eq!(
        env.ui.asked.load(Ordering::SeqCst),
        0,
        "the computer doesn't ask"
    );
    assert!(
        listing(&env.recv_dir).is_empty(),
        "nothing in the desktop's folder"
    );

    let offer = pb.call("POST", "/inbox", b"").await.1["offer"].clone();
    assert_eq!(offer["from"], "Leo's iPhone");
    let o = offer["id"].as_u64().unwrap();
    assert!(o < (1 << 53), "fits a JS number");
    pb.call("POST", &format!("/offer/accept?o={o}"), b"").await;
    pb.ctr += 2;
    let (c0, c1) = tokio::join!(pb.pull(o, 0, 0, pb.ctr - 1), pb.pull(o, 0, 1, pb.ctr));
    assert_eq!([c0.unwrap(), c1.unwrap()].concat(), data);
    assert_eq!(
        pb.call("POST", &format!("/offer/done?o={o}"), b"").await.1["result"],
        "completed"
    );
    assert!(
        listing(&relay).is_empty(),
        "relay folder removed: {:?}",
        listing(&relay)
    );
    assert!(env.outcomes.try_recv().is_err(), "desktop UI saw nothing");

    // Unknown handle, and a phone that's too big to take.
    let bad = json!({ "files": [{ "name": "a", "size": 1 }], "to": "00" });
    assert_eq!(
        pa.call("POST", "/request", bad.to_string().as_bytes())
            .await
            .1["result"],
        "unavailable"
    );
    let huge = json!({ "files": [{ "name": "a", "size": 2_000_000_000u64 }], "to": handle });
    assert_eq!(
        pa.call("POST", "/request", huge.to_string().as_bytes())
            .await
            .1["result"],
        "too_big"
    );
}

#[tokio::test]
async fn cancelled_relay_upload_leaves_nothing_behind() {
    let limits = LinkLimits {
        inbox_wait: Duration::from_millis(200),
        ..LinkLimits::default()
    };
    let env = setup_with("relay-cancel", Mode::Accept, limits).await;
    let relay = env.root.join("relay");
    env.link.set_relay_dir(relay.clone());
    let b = Phone {
        id: [0x44; 16],
        key: [0x55; 32],
        name: "B".into(),
    };
    env.link.set_phones(vec![env.phone.clone(), b.clone()]);
    let mut pa = FakePhone::hello(env.addr, &env.phone).await;
    let mut pb = FakePhone::hello(env.addr, &b).await;
    pb.call("POST", "/inbox", b"").await;
    let handle = pa.call("POST", "/peers", b"").await.1["phones"][0]["id"].clone();
    let req = json!({ "files": [{ "name": "x.bin", "size": CHUNK * 2 }], "to": handle });
    assert_eq!(
        pa.call("POST", "/request", req.to_string().as_bytes())
            .await
            .1["result"],
        "accepted"
    );
    pa.call("POST", "/chunk?f=0&i=0", &vec![7; CHUNK]).await;
    assert_eq!(
        pa.call("POST", "/cancel", b"").await.1["result"],
        "cancelled"
    );
    assert!(listing(&relay).is_empty(), "{:?}", listing(&relay));
    assert!(pb.call("POST", "/inbox", b"").await.1["offer"].is_null());
}

// ---------- through the relay (ADR-003) ----------

mod relay {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use yon_lib::link::remote::{self, RemoteStatus};

    type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// A fake relay: accepts the computer, checks its secret, confirms `room`.
    async fn relay_with(
        room: impl Fn(&[u8; 32]) -> String,
    ) -> (SocketAddr, tokio::task::JoinHandle<(Ws, String)>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let secret = [0x5a; 32];
        let confirm = room(&secret);
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let Some(Ok(Message::Text(sent))) = ws.next().await else {
                panic!("no secret")
            };
            ws.send(Message::Text(confirm.into())).await.unwrap();
            (ws, sent.to_string())
        });
        (addr, task)
    }

    fn frame(
        phone: u32,
        req: u32,
        method: &str,
        target: &str,
        headers: &[(&str, String)],
        body: &[u8],
    ) -> Vec<u8> {
        let head = json!({ "m": method, "t": target, "h": headers }).to_string();
        let mut f = Vec::new();
        f.extend_from_slice(&phone.to_be_bytes());
        f.extend_from_slice(&req.to_be_bytes());
        f.extend_from_slice(&(head.len() as u16).to_be_bytes());
        f.extend_from_slice(head.as_bytes());
        f.extend_from_slice(body);
        f
    }

    /// Returns (phone id, request id, status, headers, body).
    async fn reply(ws: &mut Ws) -> (u32, u32, u16, Vec<(String, String)>, Vec<u8>) {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .unwrap()
            {
                Some(Ok(Message::Binary(b))) => {
                    let hl = u16::from_be_bytes([b[8], b[9]]) as usize;
                    let head: Value = serde_json::from_slice(&b[10..10 + hl]).unwrap();
                    let headers = serde_json::from_value(head["h"].clone()).unwrap();
                    return (
                        u32::from_be_bytes(b[0..4].try_into().unwrap()),
                        u32::from_be_bytes(b[4..8].try_into().unwrap()),
                        head["s"].as_u64().unwrap() as u16,
                        headers,
                        b[10 + hl..].to_vec(),
                    );
                }
                Some(Ok(_)) => continue, // pings
                other => panic!("relay socket ended: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn phone_talks_to_link_through_the_relay() {
        let env = setup("remote", Mode::Accept).await;
        let (addr, relay) = relay_with(remote::room_id).await;
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let seen = statuses.clone();
        let client = tokio::spawn(remote::run(
            env.link.clone(),
            format!("ws://{addr}"),
            [0x5a; 32],
            CHUNK + 64,
            move |s| seen.lock().unwrap().push(s),
        ));
        let (mut ws, secret) = relay.await.unwrap();
        assert_eq!(secret, hex(&[0x5a; 32]));

        // /hello through the relay, then a sealed /peers with the session key.
        let nc = [0x33u8; 16];
        let hello = format!("/hello?p={}&nc={}", hex(&env.phone.id), hex(&nc));
        ws.send(Message::Binary(frame(7, 1, "GET", &hello, &[], b"").into()))
            .await
            .unwrap();
        let (phone, req, status, _, body) = reply(&mut ws).await;
        assert_eq!((phone, req, status), (7, 1, 200));
        let v: Value = serde_json::from_slice(&body).unwrap();
        let sid = unhex::<16>(v["sid"].as_str().unwrap()).unwrap();
        let key = SessionKey::derive(
            &env.phone.key,
            &unhex::<16>(v["ns"].as_str().unwrap()).unwrap(),
            &nc,
        );

        let sealed = key.seal(Dir::PhoneToComputer, 1, "POST /peers", &sid, b"");
        let h = [("X-Yon-Sid", hex(&sid)), ("X-Yon-Ctr", "1".to_string())];
        ws.send(Message::Binary(
            frame(7, 2, "POST", "/peers", &h, &sealed).into(),
        ))
        .await
        .unwrap();
        let (_, req, status, headers, body) = reply(&mut ws).await;
        assert_eq!((req, status), (2, 200));
        let out: u64 = headers
            .iter()
            .find(|(k, _)| k == "x-yon-ctr")
            .unwrap()
            .1
            .parse()
            .unwrap();
        let plain = key
            .open(Dir::ComputerToPhone, out, "POST /peers", &sid, &body)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&plain).unwrap()["computer"],
            "Test Mac"
        );

        // Garbage is dropped without an answer; the connection stays up.
        ws.send(Message::Binary(vec![1, 2, 3].into()))
            .await
            .unwrap();
        ws.send(Message::Binary(frame(7, 3, "DELETE", "/", &[], b"").into()))
            .await
            .unwrap();
        ws.send(Message::Binary(
            frame(7, 4, "GET", "/nope", &[], b"").into(),
        ))
        .await
        .unwrap();
        assert_eq!(
            reply(&mut ws).await.1,
            4,
            "only the valid frame is answered"
        );
        assert!(statuses.lock().unwrap().contains(&RemoteStatus::Connected));
        client.abort();
    }

    #[tokio::test]
    async fn refuses_a_relay_that_confirms_another_room() {
        let env = setup("remote-bad", Mode::Accept).await;
        let (addr, relay) = relay_with(|_| "00".repeat(32)).await;
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let seen = statuses.clone();
        let client = tokio::spawn(remote::run(
            env.link.clone(),
            format!("ws://{addr}"),
            [0x5a; 32],
            CHUNK + 64,
            move |s| seen.lock().unwrap().push(s),
        ));
        let _ = relay.await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let got = statuses.lock().unwrap().clone();
        assert!(!got.contains(&RemoteStatus::Connected), "{got:?}");
        assert!(
            got.iter().any(
                |s| matches!(s, RemoteStatus::Error { message } if message.contains("wrong room"))
            ),
            "{got:?}"
        );
        client.abort();
    }
}

#[tokio::test]
async fn authenticated_fires_only_after_valid_sealed_request() {
    let env = setup("authed", Mode::Accept).await;
    let seen = Arc::new(Mutex::new(Vec::<[u8; 16]>::new()));
    let log = seen.clone();
    env.link
        .set_on_authenticated(Arc::new(move |id| log.lock().unwrap().push(id)));

    // /hello alone proves nothing.
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    assert!(seen.lock().unwrap().is_empty(), "hello");
    // Wrong key → bad tag.
    let mut wrong = FakePhone::hello(
        env.addr,
        &Phone {
            key: [0x44; 32],
            ..env.phone.clone()
        },
    )
    .await;
    assert_eq!(wrong.call("POST", "/status", b"").await.0, 404);
    assert!(seen.lock().unwrap().is_empty(), "bad tag");

    // First valid sealed request fires once; later ones and replays don't.
    assert_eq!(p.call("POST", "/status", b"").await.0, 200);
    assert_eq!(p.raw_call("POST", "/status", b"", 1).await.0, 404, "replay");
    assert_eq!(p.call("POST", "/status", b"").await.0, 200);
    assert_eq!(*seen.lock().unwrap(), vec![env.phone.id]);

    // A new session fires again.
    let mut again = FakePhone::hello(env.addr, &env.phone).await;
    assert_eq!(again.call("POST", "/status", b"").await.0, 200);
    assert_eq!(seen.lock().unwrap().len(), 2);
}
