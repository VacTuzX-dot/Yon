//! Streaming file I/O for transfers: bounded memory, SHA-256 on the fly,
//! race-free no-overwrite naming, and cleanup that survives cancellation.

use ring::digest::{Context, SHA256};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

pub const CHUNK: usize = 256 * 1024;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const PART_EXT: &str = "yonpart";
const MAX_SUFFIX: u32 = 10_000;

/// A final name claimed on disk (0-byte placeholder) plus the `.yonpart`
/// file being written. Dropped without [`Reserved::commit`] → both removed.
pub struct Reserved {
    pub final_path: PathBuf,
    part_path: PathBuf,
    committed: bool,
}

impl Reserved {
    /// Claim a unique name in `dir` for an already-sanitized `name`,
    /// appending ` (1)`, ` (2)`… on collision. `create_new` makes the claim
    /// atomic, so concurrent receives or existing files are never overwritten.
    pub fn claim(dir: &Path, name: &str) -> io::Result<Self> {
        for n in 0..MAX_SUFFIX {
            let candidate = if n == 0 {
                name.to_string()
            } else {
                with_suffix(name, n)
            };
            let final_path = dir.join(&candidate);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&final_path)
            {
                Ok(_) => {
                    let part_path = dir.join(format!("{candidate}.{PART_EXT}"));
                    return Ok(Self {
                        final_path,
                        part_path,
                        committed: false,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "no free file name",
        ))
    }

    pub async fn open_part(&self) -> io::Result<tokio::fs::File> {
        tokio::fs::File::create(&self.part_path).await
    }

    /// Move the verified `.yonpart` over our own placeholder.
    pub fn commit(mut self) -> io::Result<PathBuf> {
        fs::rename(&self.part_path, &self.final_path)?;
        self.committed = true;
        Ok(self.final_path.clone())
    }
}

impl Drop for Reserved {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.part_path);
            let _ = fs::remove_file(&self.final_path);
        }
    }
}

fn with_suffix(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

/// Remove leftovers from a crash: every `*.yonpart` and its 0-byte
/// placeholder. Safe only when no receive is running (i.e. at startup).
pub fn sweep_partials(dir: &Path) -> io::Result<usize> {
    let mut removed = 0;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(PART_EXT) {
            continue;
        }
        let placeholder = path.with_extension("");
        if fs::metadata(&placeholder)
            .map(|m| m.len() == 0)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&placeholder);
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[derive(Debug)]
pub enum BodyError {
    Io(io::Error),
    /// Peer stopped sending for [`IDLE_TIMEOUT`].
    Idle,
    /// Peer closed before `size` bytes arrived.
    Truncated,
    /// Source file changed size since it was selected.
    SourceChanged,
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BodyError::Io(e) => write!(f, "{e}"),
            BodyError::Idle => write!(f, "connection stalled"),
            BodyError::Truncated => write!(f, "connection closed mid-file"),
            BodyError::SourceChanged => write!(f, "file changed while sending"),
        }
    }
}

impl From<io::Error> for BodyError {
    fn from(e: io::Error) -> Self {
        BodyError::Io(e)
    }
}

/// Copy exactly `size` bytes from `r` to `w`, returning their SHA-256.
/// Reads never go past `size`, so the next frame stays in the stream.
pub async fn recv_body<R, W>(
    r: &mut R,
    w: &mut W,
    size: u64,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<[u8; 32], BodyError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut hash = Context::new(&SHA256);
    let mut buf = vec![0u8; CHUNK];
    let mut left = size;
    while left > 0 {
        let want = left.min(CHUNK as u64) as usize;
        let n = match timeout(IDLE_TIMEOUT, r.read(&mut buf[..want])).await {
            Err(_) => return Err(BodyError::Idle),
            // WHY: over TLS, a peer that just closes the socket (no
            // close_notify) surfaces as UnexpectedEof, not Ok(0).
            Ok(Err(e)) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
            Ok(r) => r?,
        };
        if n == 0 {
            return Err(BodyError::Truncated);
        }
        hash.update(&buf[..n]);
        w.write_all(&buf[..n]).await?;
        left -= n as u64;
        progress(n as u64);
    }
    w.flush().await?;
    Ok(finish(hash))
}

/// Stream `path` (expected `size` bytes) into `w`, returning its SHA-256.
pub async fn send_body<W: AsyncWrite + Unpin>(
    path: &Path,
    size: u64,
    w: &mut W,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<[u8; 32], BodyError> {
    let mut file = tokio::fs::File::open(path).await?;
    if file.metadata().await?.len() != size {
        return Err(BodyError::SourceChanged);
    }
    let mut hash = Context::new(&SHA256);
    let mut buf = vec![0u8; CHUNK];
    let mut left = size;
    while left > 0 {
        let want = left.min(CHUNK as u64) as usize;
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(BodyError::SourceChanged);
        }
        hash.update(&buf[..n]);
        timeout(IDLE_TIMEOUT, w.write_all(&buf[..n]))
            .await
            .map_err(|_| BodyError::Idle)??;
        left -= n as u64;
        progress(n as u64);
    }
    w.flush().await?;
    Ok(finish(hash))
}

fn finish(hash: Context) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(hash.finish().as_ref());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::tests::temp_dir;
    use crate::protocol::hex;

    #[test]
    fn suffix_goes_before_extension() {
        assert_eq!(with_suffix("a.txt", 1), "a (1).txt");
        assert_eq!(with_suffix("noext", 2), "noext (2)");
        assert_eq!(with_suffix(".env", 1), ".env (1)");
    }

    #[test]
    fn claim_never_overwrites() {
        let dir = temp_dir("claim");
        fs::write(dir.join("a.txt"), b"original").unwrap();
        let r1 = Reserved::claim(&dir, "a.txt").unwrap();
        let r2 = Reserved::claim(&dir, "a.txt").unwrap();
        assert_eq!(r1.final_path, dir.join("a (1).txt"));
        assert_eq!(r2.final_path, dir.join("a (2).txt"));
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"original");
        drop((r1, r2));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_claims_are_unique() {
        let dir = temp_dir("race");
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let d = dir.clone();
                std::thread::spawn(move || Reserved::claim(&d, "x.bin").unwrap())
            })
            .collect();
        let claims: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let mut paths: Vec<_> = claims.iter().map(|c| c.final_path.clone()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 16);
        drop(claims);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn commit_keeps_file_and_drop_cleans_up() {
        let dir = temp_dir("commit");
        let ok = Reserved::claim(&dir, "ok.txt").unwrap();
        let mut f = ok.open_part().await.unwrap();
        f.write_all(b"data").await.unwrap();
        // WHY: tokio::fs writes in a background task; without flush the
        // bytes may not be on disk yet when we rename (flaky on slow CI).
        f.flush().await.unwrap();
        drop(f);
        let path = ok.commit().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"data");

        let bad = Reserved::claim(&dir, "bad.txt").unwrap();
        let f = bad.open_part().await.unwrap();
        drop(f); // WHY: Windows can't delete a file with an open handle
        drop(bad);
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("ok.txt")]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sweep_removes_leftovers_only() {
        let dir = temp_dir("sweep");
        fs::write(dir.join("keep.txt"), b"x").unwrap();
        fs::write(dir.join("crashed.bin"), b"").unwrap();
        fs::write(dir.join("crashed.bin.yonpart"), b"partial").unwrap();
        fs::write(dir.join("real.bin"), b"user data").unwrap();
        fs::write(dir.join("real.bin.yonpart"), b"partial").unwrap();
        assert_eq!(sweep_partials(&dir).unwrap(), 2);
        assert!(dir.join("keep.txt").exists());
        assert!(!dir.join("crashed.bin").exists());
        assert!(dir.join("real.bin").exists(), "non-empty file must survive");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn body_roundtrip_hashes_match() {
        let dir = temp_dir("body");
        let src = dir.join("src.bin");
        let data: Vec<u8> = (0..(CHUNK * 3 + 17)).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &data).unwrap();

        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        let size = data.len() as u64;
        let sender =
            tokio::spawn(async move { send_body(&src, size, &mut a, &mut |_| {}).await.unwrap() });
        let mut out = Vec::new();
        let mut got = 0u64;
        let recv = recv_body(&mut b, &mut out, size, &mut |n| got += n)
            .await
            .unwrap();
        let sent = sender.await.unwrap();

        assert_eq!(recv, sent);
        assert_eq!(out, data);
        assert_eq!(got, size);
        let expect = ring::digest::digest(&SHA256, &data);
        assert_eq!(hex(&recv), hex(expect.as_ref()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn recv_does_not_read_past_size() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(b"helloNEXT").await.unwrap();
        let mut out = Vec::new();
        recv_body(&mut b, &mut out, 5, &mut |_| {}).await.unwrap();
        assert_eq!(out, b"hello");
        let mut rest = [0u8; 4];
        b.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"NEXT");
    }

    #[tokio::test]
    async fn recv_detects_truncation() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        a.write_all(b"abc").await.unwrap();
        drop(a);
        let mut out = Vec::new();
        let err = recv_body(&mut b, &mut out, 10, &mut |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, BodyError::Truncated));
    }

    #[tokio::test]
    async fn send_detects_changed_source() {
        let dir = temp_dir("changed");
        let src = dir.join("f");
        fs::write(&src, b"12345").unwrap();
        let mut sink = Vec::new();
        let err = send_body(&src, 99, &mut sink, &mut |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, BodyError::SourceChanged));
        fs::remove_dir_all(dir).unwrap();
    }
}
