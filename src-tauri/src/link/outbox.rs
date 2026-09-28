//! Computer → phone: files the desktop user offered to a paired phone.
//!
//! The phone's page picks the offer up from `/inbox`, accepts it, and pulls
//! each file in sealed 1 MiB chunks (`/pull`), several at a time and in any
//! order. The offer belongs to the phone, not to a session, so a page that
//! was reloaded or suspended by iOS can carry on with a fresh session.

use super::CHUNK;
use crate::client::{OutFile, SendOutcome, SendStatus};
use crate::Throttle;
use std::collections::HashSet;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Largest offer a phone gets at once: a 1000 MiB download was the largest
/// size tested to work in Safari on an iPhone (ADR-001 spike, 2026-09-27).
pub const PHONE_MAX_BYTES: u64 = 1000 * 1024 * 1024;

/// Where the desktop learns how an offer is going.
pub trait OfferEvents: Send + Sync {
    fn status(&self, status: SendStatus);
    fn finished(&self, outcome: SendOutcome);
}

pub(super) struct Offer {
    pub id: u64,
    /// Shown as the sender; `None` = this computer.
    pub from: Option<String>,
    pub files: Vec<OutFile>,
    pub total: u64,
    pub accepted: bool,
    pub created: Instant,
    pub last_activity: Instant,
    served: HashSet<(usize, u64)>,
    done: u64,
    throttle: Throttle,
    events: Arc<dyn OfferEvents>,
}

impl Offer {
    pub fn new(id: u64, files: Vec<OutFile>, events: Arc<dyn OfferEvents>) -> Result<Self, String> {
        if files.is_empty() || files.len() > crate::protocol::MAX_FILES {
            return Err("Pick between 1 and 10,000 files".into());
        }
        let total = files.iter().map(|f| f.size).sum::<u64>();
        if total > PHONE_MAX_BYTES {
            return Err("Phones can receive up to 1 GB at a time. Send fewer files.".into());
        }
        let now = Instant::now();
        Ok(Self {
            id,
            from: None,
            files,
            total,
            accepted: false,
            created: now,
            last_activity: now,
            served: HashSet::new(),
            done: 0,
            throttle: Throttle::new(),
            events,
        })
    }

    pub fn status(&self, status: SendStatus) {
        self.events.status(status);
    }

    /// Consumes the offer: the desktop hears the outcome exactly once.
    pub fn finish(self, outcome: SendOutcome) {
        self.events.finished(outcome);
    }

    /// Byte range of chunk `i` of file `f`, if it exists. An empty file has
    /// exactly one (empty) chunk so the phone still creates it.
    pub fn chunk_range(&self, f: usize, i: u64) -> Option<(u64, usize)> {
        let size = self.files.get(f)?.size;
        let start = i.checked_mul(CHUNK as u64)?;
        if start >= size && !(size == 0 && i == 0) {
            return None;
        }
        Some((start, (size - start).min(CHUNK as u64) as usize))
    }

    /// Count a chunk the phone received (retries count once) and report
    /// progress now and then.
    pub fn record(&mut self, f: usize, i: u64, len: usize) {
        self.last_activity = Instant::now();
        if self.served.insert((f, i)) {
            self.done += len as u64;
            if self.throttle.ready(self.done == self.total) {
                self.status(SendStatus::Transferring {
                    done: self.done,
                    total: self.total,
                });
            }
        }
    }

    /// Every chunk of every file has been handed out at least once.
    pub fn all_served(&self) -> bool {
        let expected: u64 = self
            .files
            .iter()
            .map(|f| f.size.div_ceil(CHUNK as u64).max(1))
            .sum();
        self.served.len() as u64 == expected
    }
}

pub(super) async fn read_chunk(path: &Path, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(offset)).await?;
    let mut buf = vec![0; len];
    // A file that shrank since it was picked fails here instead of sending
    // fewer bytes than announced.
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);
    impl OfferEvents for Log {
        fn status(&self, s: SendStatus) {
            self.0.lock().unwrap().push(format!("{s:?}"));
        }
        fn finished(&self, o: SendOutcome) {
            self.0.lock().unwrap().push(format!("{o:?}"));
        }
    }

    fn file(size: u64) -> OutFile {
        OutFile {
            path: PathBuf::from("x"),
            name: "x".into(),
            size,
            dir: None,
        }
    }

    #[test]
    fn chunks_cover_each_file_exactly() {
        let big = CHUNK as u64 * 2 + 5;
        let o = Offer::new(1, vec![file(0), file(big)], Arc::new(Log::default())).unwrap();
        assert_eq!(
            o.chunk_range(0, 0),
            Some((0, 0)),
            "empty file has one chunk"
        );
        assert_eq!(o.chunk_range(0, 1), None);
        assert_eq!(o.chunk_range(1, 2), Some((CHUNK as u64 * 2, 5)));
        assert_eq!(o.chunk_range(1, 3), None);
        assert_eq!(o.chunk_range(2, 0), None, "no such file");
        assert_eq!(o.chunk_range(1, u64::MAX), None, "no overflow");
    }

    #[test]
    fn retries_count_once_and_completion_needs_every_chunk() {
        let log = Arc::new(Log::default());
        let mut o = Offer::new(1, vec![file(0), file(CHUNK as u64 + 1)], log.clone()).unwrap();
        o.record(1, 0, CHUNK);
        o.record(1, 0, CHUNK);
        o.record(0, 0, 0);
        assert!(!o.all_served());
        o.record(1, 1, 1);
        assert!(o.all_served());
        assert!(log
            .0
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains(&format!("done: {}", o.total)));
    }

    #[test]
    fn refuses_empty_and_oversized_offers() {
        let log: Arc<dyn OfferEvents> = Arc::new(Log::default());
        assert!(Offer::new(1, vec![], log.clone()).is_err());
        assert!(Offer::new(1, vec![file(PHONE_MAX_BYTES + 1)], log.clone()).is_err());
        assert!(Offer::new(1, vec![file(PHONE_MAX_BYTES)], log).is_ok());
    }
}
