//! End-to-end sender ↔ receiver over loopback TLS.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{split, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Notify};
use yon_lib::client::{self, OutFile, SendOutcome, SendStatus, Target};
use yon_lib::identity::{server_name, Identity};
use yon_lib::protocol::{read_frame, write_frame, FileMeta, Frame, TransferRequest};
use yon_lib::server::{self, Decision, IncomingRequest, Limits, Receiver, ReceiverUi, RecvOutcome};

#[derive(Clone, Copy)]
enum Mode {
    Accept,
    Decline,
    Hold,
}

struct TestUi {
    mode: Mode,
    asked: AtomicUsize,
    held: Mutex<Vec<oneshot::Sender<Decision>>>,
    last_request: Mutex<Option<IncomingRequest>>,
    progressed: Notify,
    done: mpsc::UnboundedSender<RecvOutcome>,
}

impl ReceiverUi for TestUi {
    fn ask(&self, req: IncomingRequest) -> oneshot::Receiver<Decision> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        *self.last_request.lock().unwrap() = Some(req);
        let (tx, rx) = oneshot::channel();
        match self.mode {
            Mode::Accept => tx.send(Decision::Accept).unwrap(),
            Mode::Decline => tx.send(Decision::Decline).unwrap(),
            Mode::Hold => self.held.lock().unwrap().push(tx),
        }
        rx
    }
    fn progress(&self, _id: u64, _done: u64, _total: u64) {
        self.progressed.notify_one();
    }
    fn finished(&self, _id: u64, outcome: RecvOutcome) {
        let _ = self.done.send(outcome);
    }
}

struct Env {
    receiver: Arc<Receiver>,
    ui: Arc<TestUi>,
    outcomes: mpsc::UnboundedReceiver<RecvOutcome>,
    target: Target,
    sender: Identity,
    recv_dir: PathBuf,
    src_dir: PathBuf,
    root: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn temp_root(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "yon-it-{tag}-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn setup(tag: &str, mode: Mode, limits: Limits) -> Env {
    let root = temp_root(tag);
    let recv_dir = root.join("recv");
    let src_dir = root.join("src");
    std::fs::create_dir_all(&src_dir).unwrap();
    let identity = Arc::new(Identity::load_or_create(&root.join("id-recv")).unwrap());
    let sender = Identity::load_or_create(&root.join("id-send")).unwrap();
    let (tx, outcomes) = mpsc::unbounded_channel();
    let ui = Arc::new(TestUi {
        mode,
        asked: AtomicUsize::new(0),
        held: Mutex::new(vec![]),
        last_request: Mutex::new(None),
        progressed: Notify::new(),
        done: tx,
    });
    let receiver = Receiver::new(
        identity.clone(),
        Arc::new(RwLock::new(recv_dir.clone())),
        ui.clone(),
        limits,
    );
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(receiver.clone().serve(listener));
    let target = Target {
        addr: ([127, 0, 0, 1], port).into(),
        fingerprint: identity.fingerprint,
    };
    Env {
        receiver,
        ui,
        outcomes,
        target,
        sender,
        recv_dir,
        src_dir,
        root,
    }
}

fn make_file(dir: &Path, name: &str, data: &[u8]) -> OutFile {
    let path = dir.join(name.replace(['/', '\\'], "_"));
    std::fs::write(&path, data).unwrap();
    OutFile {
        path,
        name: name.to_string(),
        size: data.len() as u64,
    }
}

fn big_file(dir: &Path, name: &str, size: usize) -> OutFile {
    let data: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
    make_file(dir, name, &data)
}

async fn send(env: &Env, files: &[OutFile], cancel: Arc<Notify>) -> SendOutcome {
    client::send(
        &env.sender,
        "Tester",
        "macos",
        &env.target,
        files,
        cancel,
        &mut |_| {},
    )
    .await
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
        .expect("receiver outcome")
        .unwrap()
}

#[tokio::test]
async fn accept_saves_sanitized_unique_files() {
    let mut env = setup("accept", Mode::Accept, Limits::default()).await;
    std::fs::create_dir_all(&env.recv_dir).unwrap();
    std::fs::write(env.recv_dir.join("a.txt"), b"existing").unwrap();

    let files = vec![
        make_file(&env.src_dir, "a.txt", b"hello"),
        make_file(&env.src_dir, "../../evil.txt", b"nope"),
        make_file(&env.src_dir, "CON", b""),
    ];
    let out = send(&env, &files, Arc::new(Notify::new())).await;
    assert_eq!(out, SendOutcome::Completed);
    assert!(matches!(next(&mut env).await, RecvOutcome::Completed { saved } if saved.len() == 3));

    assert_eq!(
        listing(&env.recv_dir),
        vec!["_CON", "a (1).txt", "a.txt", "evil.txt"]
    );
    assert_eq!(
        std::fs::read(env.recv_dir.join("a.txt")).unwrap(),
        b"existing"
    );
    assert_eq!(
        std::fs::read(env.recv_dir.join("a (1).txt")).unwrap(),
        b"hello"
    );
    assert!(
        !env.root.join("evil.txt").exists(),
        "path traversal escaped save dir"
    );

    let req = env.ui.last_request.lock().unwrap().clone().unwrap();
    assert_eq!(
        req.fingerprint, env.sender.fingerprint,
        "dialog shows the real sender key"
    );
    assert!(req.files[1].renamed && req.files[1].name == "evil.txt");
}

#[tokio::test]
async fn decline_then_cooldown() {
    let mut env = setup("decline", Mode::Decline, Limits::default()).await;
    let files = vec![make_file(&env.src_dir, "x.txt", b"x")];
    assert_eq!(
        send(&env, &files, Arc::new(Notify::new())).await,
        SendOutcome::Declined
    );
    assert!(matches!(next(&mut env).await, RecvOutcome::Declined));
    assert_eq!(
        send(&env, &files, Arc::new(Notify::new())).await,
        SendOutcome::Declined
    );
    assert_eq!(
        env.ui.asked.load(Ordering::SeqCst),
        1,
        "cooldown must not re-prompt"
    );
    assert!(listing(&env.recv_dir).is_empty());
}

#[tokio::test]
async fn busy_while_dialog_open_and_sender_cancel_while_waiting() {
    let mut env = setup("busy", Mode::Hold, Limits::default()).await;
    let files = vec![make_file(&env.src_dir, "x.txt", b"x")];
    let cancel_first = Arc::new(Notify::new());
    let first = {
        let (sender_dir, target, files, cancel) = (
            env.root.join("id-send"),
            env.target.clone(),
            files.clone(),
            cancel_first.clone(),
        );
        tokio::spawn(async move {
            let id = Identity::load_or_create(&sender_dir).unwrap();
            client::send(&id, "A", "macos", &target, &files, cancel, &mut |_| {}).await
        })
    };
    while env.ui.asked.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        send(&env, &files, Arc::new(Notify::new())).await,
        SendOutcome::Busy
    );

    cancel_first.notify_one();
    assert_eq!(
        first.await.unwrap(),
        SendOutcome::Cancelled { by_receiver: false }
    );
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Cancelled {
            by_sender: true,
            ..
        }
    ));
}

#[tokio::test]
async fn accept_timeout_declines() {
    let limits = Limits {
        accept: Duration::from_millis(200),
        ..Limits::default()
    };
    let mut env = setup("timeout", Mode::Hold, limits).await;
    let files = vec![make_file(&env.src_dir, "x.txt", b"x")];
    assert_eq!(
        send(&env, &files, Arc::new(Notify::new())).await,
        SendOutcome::Declined
    );
    assert!(matches!(next(&mut env).await, RecvOutcome::TimedOut));
}

#[tokio::test]
async fn sender_cancel_mid_transfer_leaves_nothing() {
    let mut env = setup("scancel", Mode::Accept, Limits::default()).await;
    let files = vec![big_file(&env.src_dir, "big.bin", 64 << 20)];
    let cancel = Arc::new(Notify::new());
    let c = cancel.clone();
    let out = client::send(
        &env.sender,
        "T",
        "macos",
        &env.target,
        &files,
        cancel,
        &mut |s| {
            if matches!(s, SendStatus::Transferring { .. }) {
                c.notify_one();
            }
        },
    )
    .await;
    assert_eq!(out, SendOutcome::Cancelled { by_receiver: false });
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Cancelled {
            by_sender: true,
            ..
        }
    ));
    assert!(
        listing(&env.recv_dir).is_empty(),
        "{:?}",
        listing(&env.recv_dir)
    );
}

#[tokio::test]
async fn receiver_cancel_mid_transfer() {
    let mut env = setup("rcancel", Mode::Accept, Limits::default()).await;
    let files = vec![big_file(&env.src_dir, "big.bin", 256 << 20)];
    let (receiver, ui) = (env.receiver.clone(), env.ui.clone());
    tokio::spawn(async move {
        ui.progressed.notified().await;
        let id = ui.last_request.lock().unwrap().as_ref().unwrap().id;
        receiver.cancel(id);
    });
    let out = send(&env, &files, Arc::new(Notify::new())).await;
    assert_eq!(out, SendOutcome::Cancelled { by_receiver: true });
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Cancelled {
            by_sender: false,
            ..
        }
    ));
    assert!(listing(&env.recv_dir).is_empty());
}

#[tokio::test]
async fn wrong_pin_refuses_to_send() {
    let env = setup("pin", Mode::Accept, Limits::default()).await;
    let files = vec![make_file(&env.src_dir, "x.txt", b"x")];
    let target = Target {
        fingerprint: [9; 32],
        ..env.target.clone()
    };
    let out = client::send(
        &env.sender,
        "T",
        "macos",
        &target,
        &files,
        Arc::new(Notify::new()),
        &mut |_| {},
    )
    .await;
    assert!(matches!(out, SendOutcome::Failed { reason } if reason.contains("secure connection")));
    assert_eq!(env.ui.asked.load(Ordering::SeqCst), 0);
}

/// Hand-rolled sender that misbehaves after Accept.
async fn raw_send(env: &Env, declared: u64, body: &[u8], sha: &str) -> Frame {
    let cfg = env.sender.client_config(env.target.fingerprint).unwrap();
    let tcp = tokio::net::TcpStream::connect(env.target.addr)
        .await
        .unwrap();
    let tls = tokio_rustls::TlsConnector::from(cfg)
        .connect(server_name(), tcp)
        .await
        .unwrap();
    let (mut rd, mut wr) = split(tls);
    write_frame(&mut wr, &Frame::Hello { v: 1 }).await.unwrap();
    let files = vec![FileMeta {
        name: "x.bin".into(),
        size: declared,
    }];
    let req = TransferRequest {
        name: "evil".into(),
        os: "linux".into(),
        files,
    };
    write_frame(&mut wr, &Frame::Request(req)).await.unwrap();
    assert_eq!(read_frame(&mut rd).await.unwrap(), Frame::Accept);
    // WHY: the receiver may hang up before we finish writing; that's fine.
    let _ = wr.write_all(body).await;
    let _ = write_frame(&mut wr, &Frame::FileDone { sha256: sha.into() }).await;
    read_frame(&mut rd).await.unwrap()
}

#[tokio::test]
async fn checksum_mismatch_discards_file() {
    let mut env = setup("hash", Mode::Accept, Limits::default()).await;
    let reply = raw_send(&env, 4, b"abcd", &"0".repeat(64)).await;
    assert!(matches!(reply, Frame::Failed { reason } if reason.contains("checksum")));
    assert!(matches!(next(&mut env).await, RecvOutcome::Failed { .. }));
    assert!(listing(&env.recv_dir).is_empty());
}

#[tokio::test]
async fn sending_more_than_declared_is_rejected() {
    let mut env = setup("oversize", Mode::Accept, Limits::default()).await;
    let reply = raw_send(&env, 4, b"abcdEXTRA-BYTES-THAT-WERE-NOT-DECLARED", "00").await;
    assert!(matches!(reply, Frame::Failed { .. }));
    assert!(matches!(next(&mut env).await, RecvOutcome::Failed { .. }));
    assert!(listing(&env.recv_dir).is_empty());
}

/// Acceptance: 1 GB transfer, bounded memory, identical SHA-256.
/// Run: `cargo test --release --test transfer -- --ignored one_gigabyte`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn one_gigabyte() {
    use ring::digest::{Context, SHA256};
    use std::io::{Read, Write};

    let mut env = setup("1gb", Mode::Accept, Limits::default()).await;
    let src = env.src_dir.join("1gb.bin");
    {
        let mut f = std::fs::File::create(&src).unwrap();
        let mut block = vec![0u8; 1 << 20];
        let mut x: u32 = 0x1234_5678;
        for _ in 0..1024 {
            for b in block.iter_mut() {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                *b = x as u8;
            }
            f.write_all(&block).unwrap();
        }
    }
    let files = vec![OutFile {
        path: src.clone(),
        name: "1gb.bin".into(),
        size: 1 << 30,
    }];

    let started = std::time::Instant::now();
    assert_eq!(
        send(&env, &files, Arc::new(Notify::new())).await,
        SendOutcome::Completed
    );
    let secs = started.elapsed().as_secs_f64();
    assert!(matches!(
        next(&mut env).await,
        RecvOutcome::Completed { .. }
    ));

    let sha = |p: &Path| {
        let mut f = std::fs::File::open(p).unwrap();
        let mut ctx = Context::new(&SHA256);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            ctx.update(&buf[..n]);
        }
        yon_lib::protocol::hex(ctx.finish().as_ref())
    };
    let (a, b) = (sha(&src), sha(&env.recv_dir.join("1gb.bin")));
    println!(
        "sha256 src={a}\nsha256 dst={b}\n1 GiB in {secs:.2}s = {:.0} MiB/s",
        1024.0 / secs
    );
    assert_eq!(a, b);
}
