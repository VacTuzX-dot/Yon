//! Yon wire protocol v1, carried over any byte stream (TLS/TCP today).
//!
//! Control frames: `u32 big-endian length` + JSON. File contents are sent raw
//! between frames, exactly `size` bytes per file as declared in `Request`.
//!
//! ```text
//! sender                          receiver
//!   Hello{v}                ->
//!   Request{..}             ->
//!                           <-    Accept | Decline | Busy | Unsupported | InsufficientSpace
//!   [file 0 bytes] FileDone ->
//!   ...
//!                           <-    Done | Failed{reason} | Cancel   (Cancel/Failed may arrive any time)
//! ```
//! Sender cancels by closing the connection.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1 << 20;
pub const MAX_FILES: usize = 10_000;
pub const MAX_DEVICE_NAME_BYTES: usize = 63;
const MAX_RAW_FILE_NAME_BYTES: usize = 1024;
const MAX_OS_BYTES: usize = 16;
pub const MAX_DIR_DEPTH: usize = 32;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Frame {
    Hello {
        v: u32,
    },
    Request(TransferRequest),
    Accept,
    Decline,
    Busy,
    Unsupported {
        supported: Vec<u32>,
    },
    InsufficientSpace,
    /// SHA-256 of the file just sent, lowercase hex.
    FileDone {
        sha256: String,
    },
    Done,
    Failed {
        reason: String,
    },
    Cancel,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransferRequest {
    pub name: String,
    pub os: String,
    pub files: Vec<FileMeta>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    pub name: String,
    pub size: u64,
    /// Folder the file sits in, relative to what was sent, `/`-separated
    /// ("Photos/2024"). Absent for loose files. Older receivers ignore it and
    /// save everything flat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

#[derive(Debug)]
pub enum ProtoError {
    Io(io::Error),
    FrameTooLarge(usize),
    Malformed(String),
    Invalid(&'static str),
    Unexpected(&'static str),
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtoError::Io(e) => write!(f, "connection error: {e}"),
            ProtoError::FrameTooLarge(n) => write!(f, "frame too large ({n} bytes)"),
            ProtoError::Malformed(e) => write!(f, "malformed message: {e}"),
            ProtoError::Invalid(why) => write!(f, "invalid request: {why}"),
            ProtoError::Unexpected(what) => write!(f, "protocol violation: {what}"),
        }
    }
}

impl std::error::Error for ProtoError {}

impl From<io::Error> for ProtoError {
    fn from(e: io::Error) -> Self {
        ProtoError::Io(e)
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    frame: &Frame,
) -> Result<(), ProtoError> {
    let body = serde_json::to_vec(frame).map_err(|e| ProtoError::Malformed(e.to_string()))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(ProtoError::FrameTooLarge(body.len()));
    }
    // WHY: length fits in u32 because MAX_FRAME_BYTES < u32::MAX.
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Frame, ProtoError> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    // Checked before allocating: a hostile length must not reserve memory.
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(ProtoError::FrameTooLarge(len));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|e| ProtoError::Malformed(e.to_string()))
}

impl TransferRequest {
    /// Structural checks on an untrusted request. File names are *not*
    /// rejected for content — the receiver sanitizes them instead.
    pub fn validate(&self) -> Result<u64, ProtoError> {
        if self.files.is_empty() {
            return Err(ProtoError::Invalid("no files"));
        }
        if self.files.len() > MAX_FILES {
            return Err(ProtoError::Invalid("too many files"));
        }
        if self.name.len() > MAX_DEVICE_NAME_BYTES || self.os.len() > MAX_OS_BYTES {
            return Err(ProtoError::Invalid("sender info too long"));
        }
        let mut total: u64 = 0;
        for f in &self.files {
            if f.name.len() > MAX_RAW_FILE_NAME_BYTES {
                return Err(ProtoError::Invalid("file name too long"));
            }
            if let Some(dir) = &f.dir {
                // WHY: both separators — the receiver splits on either.
                if dir.len() > MAX_RAW_FILE_NAME_BYTES
                    || dir.split(['/', '\\']).count() > MAX_DIR_DEPTH
                {
                    return Err(ProtoError::Invalid("folder path too long"));
                }
            }
            total = total
                .checked_add(f.size)
                .ok_or(ProtoError::Invalid("total size overflow"))?;
        }
        Ok(total)
    }
}

/// Lowercase hex, used for digests and fingerprints.
pub fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// Parse exactly `N` bytes of hex (either case). `None` for anything else.
pub fn unhex<const N: usize>(s: &str) -> Option<[u8; N]> {
    // WHY: from_str_radix alone accepts a leading '+' ("+1" parses as 1).
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(files: Vec<FileMeta>) -> TransferRequest {
        TransferRequest {
            name: "Mac".into(),
            os: "macos".into(),
            files,
        }
    }

    fn file(size: u64) -> FileMeta {
        FileMeta {
            name: "a.txt".into(),
            size,
            dir: None,
        }
    }

    #[tokio::test]
    async fn frame_roundtrip() {
        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        let frames = vec![
            Frame::Hello { v: 1 },
            Frame::Request(req(vec![file(5)])),
            Frame::Accept,
            Frame::FileDone {
                sha256: "ab".into(),
            },
            Frame::Failed { reason: "x".into() },
        ];
        for f in &frames {
            write_frame(&mut a, f).await.unwrap();
        }
        for f in &frames {
            assert_eq!(&read_frame(&mut b).await.unwrap(), f);
        }
    }

    #[test]
    fn wire_format_is_tagged_json() {
        let json = serde_json::to_string(&Frame::Hello { v: 1 }).unwrap();
        assert_eq!(json, r#"{"t":"hello","v":1}"#);
    }

    #[tokio::test]
    async fn rejects_oversized_length_without_allocating() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(ProtoError::FrameTooLarge(_))
        ));
    }

    #[tokio::test]
    async fn rejects_zero_length() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&0u32.to_be_bytes()).await.unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(ProtoError::FrameTooLarge(0))
        ));
    }

    #[tokio::test]
    async fn rejects_malformed_json() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&4u32.to_be_bytes()).await.unwrap();
        a.write_all(b"nope").await.unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(ProtoError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn rejects_unknown_tag() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let body = br#"{"t":"exec"}"#;
        a.write_all(&(body.len() as u32).to_be_bytes())
            .await
            .unwrap();
        a.write_all(body).await.unwrap();
        assert!(matches!(
            read_frame(&mut b).await,
            Err(ProtoError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn truncated_frame_is_io_error() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"{\"t\"").await.unwrap();
        drop(a);
        assert!(matches!(read_frame(&mut b).await, Err(ProtoError::Io(_))));
    }

    #[test]
    fn validate_accepts_normal_request() {
        assert_eq!(req(vec![file(3), file(4)]).validate().unwrap(), 7);
    }

    #[test]
    fn validate_rejects_bad_requests() {
        assert!(req(vec![]).validate().is_err());
        assert!(req(vec![file(1); MAX_FILES + 1]).validate().is_err());
        assert!(req(vec![file(u64::MAX), file(1)]).validate().is_err());

        let mut long_name = req(vec![file(1)]);
        long_name.name = "x".repeat(MAX_DEVICE_NAME_BYTES + 1);
        assert!(long_name.validate().is_err());

        let mut long_file = req(vec![file(1)]);
        long_file.files[0].name = "x".repeat(2000);
        assert!(long_file.validate().is_err());
    }

    #[test]
    fn folder_path_is_optional_on_the_wire() {
        // A 0.2.2 sender sends no "dir"; a 0.2.2 receiver ignores it.
        let old: FileMeta = serde_json::from_str(r#"{"name":"a.txt","size":1}"#).unwrap();
        assert_eq!(old.dir, None);
        assert!(!serde_json::to_string(&file(1)).unwrap().contains("dir"));
        let mut f = file(1);
        f.dir = Some("Photos/2024".into());
        let back: FileMeta = serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn validate_rejects_deep_or_long_folders() {
        let mut deep = file(1);
        deep.dir = Some(vec!["d"; MAX_DIR_DEPTH + 1].join("/"));
        assert!(req(vec![deep]).validate().is_err());
        let mut ok = file(1);
        ok.dir = Some(vec!["d"; MAX_DIR_DEPTH].join("/"));
        assert!(req(vec![ok]).validate().is_ok());
        let mut backslashes = file(1);
        backslashes.dir = Some(vec!["d"; MAX_DIR_DEPTH + 1].join("\\"));
        assert!(req(vec![backslashes]).validate().is_err());
        let mut long = file(1);
        long.dir = Some("x".repeat(MAX_RAW_FILE_NAME_BYTES + 1));
        assert!(req(vec![long]).validate().is_err());
    }

    #[test]
    fn validate_allows_max_files() {
        assert!(req(vec![file(1); MAX_FILES]).validate().is_ok());
    }

    #[test]
    fn unhex_roundtrip_and_rejects() {
        assert_eq!(unhex::<3>("00abFF"), Some([0x00, 0xab, 0xff]));
        assert_eq!(unhex::<2>("00ab"), Some([0, 0xab]));
        assert_eq!(unhex::<2>("00a"), None);
        assert_eq!(unhex::<2>("zzzz"), None);
        assert_eq!(unhex::<2>("\u{e9}\u{e9}"), None);
        assert_eq!(unhex::<1>("+1"), None);
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
