//! Yon Link session crypto. Must match web/crypto.ts byte for byte
//! (shared vectors in web/crypto-vectors.json).
//!
//! - Pairing key `K` (32 B) lives in the phone's saved URL and in settings.
//! - Session key `Ks = HKDF-SHA256(ikm = K, salt = Ns ‖ Nc, info = "yon-link v1")`
//!   with fresh 16-byte nonces from server (`Ns`) and phone (`Nc`).
//! - Every message: ChaCha20-Poly1305 under `Ks`, nonce = `dir ‖ 0,0,0 ‖ counter_be64`,
//!   AAD = `"yon-link v1" ‖ route ‖ sid ‖ counter_be64`.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::hkdf;

pub const INFO: &[u8] = b"yon-link v1";

/// Who sealed a message. Distinct prefixes keep the two directions' nonces
/// apart even though they share one key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    PhoneToComputer = 1,
    ComputerToPhone = 2,
}

pub struct SessionKey(LessSafeKey);

impl SessionKey {
    pub fn derive(k: &[u8; 32], ns: &[u8; 16], nc: &[u8; 16]) -> Self {
        let mut salt = [0u8; 32];
        salt[..16].copy_from_slice(ns);
        salt[16..].copy_from_slice(nc);
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(k);
        let okm = prk
            .expand(&[INFO], &CHACHA20_POLY1305)
            .expect("32-byte output is within HKDF limits");
        Self(LessSafeKey::new(UnboundKey::from(okm)))
    }

    pub fn seal(
        &self,
        dir: Dir,
        counter: u64,
        route: &str,
        sid: &[u8; 16],
        plain: &[u8],
    ) -> Vec<u8> {
        let mut buf = plain.to_vec();
        self.0
            .seal_in_place_append_tag(
                nonce(dir, counter),
                Aad::from(aad(route, sid, counter)),
                &mut buf,
            )
            .expect("ChaCha20-Poly1305 seal cannot fail for in-memory buffers");
        buf
    }

    /// `None` for any tampering, wrong key, wrong route/session/counter.
    pub fn open(
        &self,
        dir: Dir,
        counter: u64,
        route: &str,
        sid: &[u8; 16],
        sealed: &[u8],
    ) -> Option<Vec<u8>> {
        let mut buf = sealed.to_vec();
        let n = self
            .0
            .open_in_place(
                nonce(dir, counter),
                Aad::from(aad(route, sid, counter)),
                &mut buf,
            )
            .ok()?
            .len();
        buf.truncate(n);
        Some(buf)
    }
}

fn nonce(dir: Dir, counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[0] = dir as u8;
    n[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(n)
}

fn aad(route: &str, sid: &[u8; 16], counter: u64) -> Vec<u8> {
    let mut a = Vec::with_capacity(INFO.len() + route.len() + 24);
    a.extend_from_slice(INFO);
    a.extend_from_slice(route.as_bytes());
    a.extend_from_slice(sid);
    a.extend_from_slice(&counter.to_be_bytes());
    a
}

/// Anti-replay window over message counters (as in IPsec/DTLS): each counter
/// is accepted once, and up to 64 messages may arrive out of order, which
/// happens when the phone runs requests in parallel. Counter 0 is never valid.
/// Call `is_fresh` before opening and `mark` only after a message opened, so
/// forged messages can't move the window.
#[derive(Default, Clone, Copy, Debug)]
pub struct ReplayWindow {
    max: u64,
    /// Bit n set = counter `max - n` was seen.
    seen: u64,
}

impl ReplayWindow {
    const SIZE: u64 = 64;

    pub fn is_fresh(&self, ctr: u64) -> bool {
        if ctr == 0 {
            return false;
        }
        if ctr > self.max {
            return true;
        }
        let age = self.max - ctr;
        age < Self::SIZE && self.seen & (1 << age) == 0
    }

    pub fn mark(&mut self, ctr: u64) {
        if ctr > self.max {
            let shift = ctr - self.max;
            self.seen = if shift >= Self::SIZE {
                0
            } else {
                self.seen << shift
            };
            self.seen |= 1;
            self.max = ctr;
        } else {
            self.seen |= 1 << (self.max - ctr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_window_allows_reordering_but_never_twice() {
        let mut w = ReplayWindow::default();
        assert!(!w.is_fresh(0));
        for c in [1, 3, 2, 10, 5] {
            assert!(w.is_fresh(c), "{c} first time");
            w.mark(c);
            assert!(!w.is_fresh(c), "{c} replayed");
        }
        assert!(w.is_fresh(4) && w.is_fresh(9));
        w.mark(80);
        assert!(
            !w.is_fresh(10) && !w.is_fresh(16),
            "older than 64 behind 80"
        );
        assert!(w.is_fresh(17), "exactly 63 behind is still in the window");
        w.mark(17);
        assert!(!w.is_fresh(17));
        w.mark(1000);
        assert!(!w.is_fresh(80) && w.is_fresh(999));
    }
    use crate::identity::parse_fingerprint;
    use crate::protocol::hex;

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let mut out = [0u8; N];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    /// Cross-language check: the same file is asserted by web/crypto.test.ts,
    /// so ring (here) and @noble (phone) must agree byte for byte.
    #[test]
    fn matches_shared_vectors() {
        let json: serde_json::Value =
            serde_json::from_str(include_str!("../../../web/crypto-vectors.json")).unwrap();
        for v in json.as_array().unwrap() {
            let s = |k: &str| v[k].as_str().unwrap();
            let key = SessionKey::derive(
                &parse_fingerprint(s("k")).unwrap(),
                &unhex(s("ns")),
                &unhex(s("nc")),
            );
            let dir = if v["dir"] == 1 {
                Dir::PhoneToComputer
            } else {
                Dir::ComputerToPhone
            };
            // String: u64::MAX doesn't survive JSON numbers in JavaScript.
            let counter: u64 = s("counter").parse().unwrap();
            let sid = unhex(s("sid"));
            let sealed = key.seal(dir, counter, s("route"), &sid, s("plain").as_bytes());
            assert_eq!(hex(&sealed), s("sealed"), "vector {}", s("name"));
            let opened = key.open(dir, counter, s("route"), &sid, &sealed).unwrap();
            assert_eq!(opened, s("plain").as_bytes());
        }
    }

    #[test]
    fn any_change_fails_to_open() {
        let key = SessionKey::derive(&[7; 32], &[1; 16], &[2; 16]);
        let sid = [3; 16];
        let sealed = key.seal(Dir::PhoneToComputer, 5, "POST /chunk", &sid, b"hello");
        let open = |d, c, r: &str, s: &[u8; 16], b: &[u8]| key.open(d, c, r, s, b);
        assert!(open(Dir::PhoneToComputer, 5, "POST /chunk", &sid, &sealed).is_some());
        assert!(
            open(Dir::ComputerToPhone, 5, "POST /chunk", &sid, &sealed).is_none(),
            "direction"
        );
        assert!(
            open(Dir::PhoneToComputer, 6, "POST /chunk", &sid, &sealed).is_none(),
            "counter"
        );
        assert!(
            open(Dir::PhoneToComputer, 5, "POST /done", &sid, &sealed).is_none(),
            "route"
        );
        assert!(
            open(Dir::PhoneToComputer, 5, "POST /chunk", &[4; 16], &sealed).is_none(),
            "session"
        );
        let mut flipped = sealed.clone();
        flipped[0] ^= 1;
        assert!(
            open(Dir::PhoneToComputer, 5, "POST /chunk", &sid, &flipped).is_none(),
            "tamper"
        );
        let other = SessionKey::derive(&[7; 32], &[1; 16], &[9; 16]);
        assert!(
            other
                .open(Dir::PhoneToComputer, 5, "POST /chunk", &sid, &sealed)
                .is_none(),
            "nonce Nc"
        );
        assert!(
            open(Dir::PhoneToComputer, 5, "POST /chunk", &sid, &sealed[..4]).is_none(),
            "short"
        );
    }

    /// Prints fresh vectors (run with --ignored --nocapture) — only used to
    /// seed web/crypto-vectors.json; the checked-in file is the contract.
    #[test]
    #[ignore]
    fn print_vectors() {
        let cases = [
            (
                "chunk",
                "11".repeat(32),
                "22".repeat(16),
                "33".repeat(16),
                1u8,
                1u64,
                "POST /chunk",
                "44".repeat(16),
                "hello yon",
            ),
            (
                "reply",
                "a0".repeat(32),
                "b1".repeat(16),
                "c2".repeat(16),
                2,
                42,
                "POST /request",
                "d3".repeat(16),
                "{\"ok\":true}",
            ),
            (
                "empty",
                "00".repeat(32),
                "ff".repeat(16),
                "01".repeat(16),
                1,
                u64::MAX,
                "POST /done",
                "02".repeat(16),
                "",
            ),
        ];
        let mut out = Vec::new();
        for (name, k, ns, nc, dir, counter, route, sid, plain) in cases {
            let key = SessionKey::derive(&parse_fingerprint(&k).unwrap(), &unhex(&ns), &unhex(&nc));
            let d = if dir == 1 {
                Dir::PhoneToComputer
            } else {
                Dir::ComputerToPhone
            };
            let sealed = key.seal(d, counter, route, &unhex(&sid), plain.as_bytes());
            out.push(serde_json::json!({"name": name, "k": k, "ns": ns, "nc": nc, "dir": dir,
                "counter": counter.to_string(), "route": route, "sid": sid, "plain": plain, "sealed": hex(&sealed)}));
        }
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
    }
}
