//! Web Push to a paired phone: payload encryption (RFC 8291, `aes128gcm`) and
//! VAPID authorization (RFC 8292). Spec: docs/superpowers/specs/2026-10-13-phone-push-design.md.
//!
//! The VAPID key belongs to the phone (it subscribed with it) and is handed to
//! each of its computers over the sealed Yon Link session, so any of them can
//! push to that phone and nothing else. Only `ring` is used.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_128_GCM};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf::{self, KeyType, Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

/// Record size advertised in the header; the whole payload is one record.
const RECORD_SIZE: u32 = 4096;
/// Largest plaintext that fits one record (padding delimiter + GCM tag).
pub const MAX_PLAINTEXT: usize = RECORD_SIZE as usize - 1 - 16;

/// Errors carry no key material.
#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    BadKey,
    TooLarge,
    Crypto,
}

/// HKDF output length, as ring wants it.
struct Len(usize);
impl KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_expand(prk: &hkdf::Prk, info: &[u8], out: &mut [u8]) -> Result<(), PushError> {
    prk.expand(&[info], Len(out.len()))
        .and_then(|okm| okm.fill(out))
        .map_err(|_| PushError::Crypto)
}

/// Encrypts `plaintext` for a subscription (`ua_public`: the 65-byte `p256dh`,
/// `auth`: its 16-byte secret). Returns the request body: header ‖ record.
pub fn encrypt(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
    rng: &dyn SecureRandom,
) -> Result<Vec<u8>, PushError> {
    if ua_public.len() != 65 || ua_public[0] != 0x04 || auth.len() != 16 {
        return Err(PushError::BadKey);
    }
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(PushError::TooLarge);
    }
    let mut salt = [0u8; 16];
    rng.fill(&mut salt).map_err(|_| PushError::Crypto)?;
    let private = EphemeralPrivateKey::generate(&ECDH_P256, rng).map_err(|_| PushError::Crypto)?;
    let as_public = private
        .compute_public_key()
        .map_err(|_| PushError::Crypto)?;
    let peer = UnparsedPublicKey::new(&ECDH_P256, ua_public);
    // WHY: ring rejects a point that isn't on the curve here, so a bad
    // p256dh fails cleanly instead of producing a useless message.
    let secret = agree_ephemeral(private, &peer, |s| s.to_vec()).map_err(|_| PushError::BadKey)?;
    encrypt_with(
        &secret,
        as_public.as_ref(),
        ua_public,
        auth,
        &salt,
        plaintext,
    )
}

/// The deterministic part of RFC 8291, given the ECDH result; separate so the
/// RFC's §5 example can be checked byte for byte.
fn encrypt_with(
    ecdh_secret: &[u8],
    as_public: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, PushError> {
    // IKM = HKDF(auth, ecdh_secret, "WebPush: info\0" ‖ ua_public ‖ as_public, 32)
    let prk_key = Salt::new(HKDF_SHA256, auth).extract(ecdh_secret);
    let mut info = Vec::with_capacity(14 + 65 + 65);
    info.extend_from_slice(b"WebPush: info\0");
    info.extend_from_slice(ua_public);
    info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    hkdf_expand(&prk_key, &info, &mut ikm)?;

    let prk = Salt::new(HKDF_SHA256, salt).extract(&ikm);
    let mut cek = [0u8; 16];
    hkdf_expand(&prk, b"Content-Encoding: aes128gcm\0", &mut cek)?;
    let mut nonce = [0u8; 12];
    hkdf_expand(&prk, b"Content-Encoding: nonce\0", &mut nonce)?;

    let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek).map_err(|_| PushError::Crypto)?);
    let mut record = Vec::with_capacity(plaintext.len() + 1 + 16);
    record.extend_from_slice(plaintext);
    record.push(0x02); // last (and only) record, no padding
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::empty(),
        &mut record,
    )
    .map_err(|_| PushError::Crypto)?;

    // Header: salt ‖ record size ‖ key id length ‖ key id (the sender's public key).
    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + record.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

/// `Authorization` header value for a push to `audience` (the endpoint's
/// origin, e.g. `https://web.push.apple.com`), signed with the phone's VAPID
/// key: `private` is the 32-byte scalar (JWK `d`), `public` the 65-byte
/// uncompressed point (its `applicationServerKey`). `exp` is Unix seconds (at
/// most 24 h ahead per RFC 8292).
pub fn vapid_authorization(
    private: &[u8],
    public: &[u8],
    audience: &str,
    exp: u64,
    subject: &str,
    rng: &dyn SecureRandom,
) -> Result<String, PushError> {
    // WHY: raw scalar + point, not PKCS#8: WebCrypto's PKCS#8 export may omit
    // the public key, which ring's from_pkcs8 requires; JWK `d`/`x`/`y` is
    // the same in every browser. ring checks that the two match.
    let key = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        private,
        public,
        rng,
    )
    .map_err(|_| PushError::BadKey)?;
    let header = b64url(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({ "aud": audience, "exp": exp, "sub": subject });
    let claims = b64url(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{claims}");
    let sig = key
        .sign(rng, signing_input.as_bytes())
        .map_err(|_| PushError::Crypto)?;
    Ok(format!(
        "vapid t={signing_input}.{}, k={}",
        b64url(sig.as_ref()),
        b64url(key.public_key().as_ref())
    ))
}

/// The system CSPRNG, for callers.
pub fn rng() -> SystemRandom {
    SystemRandom::new()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding (RFC 4648 §5), as Web Push uses everywhere.
pub fn b64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// Strict base64url decode (no padding, no other characters); `None` if invalid.
pub fn unb64url(s: &str) -> Option<Vec<u8>> {
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    // WHY: leftover bits must be zero, so each value has exactly one encoding.
    if acc & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey as Verify, ECDSA_P256_SHA256_FIXED};

    fn d(s: &str) -> Vec<u8> {
        unb64url(s).expect("valid base64url")
    }

    /// RFC 8291 §5. Values cross-checked against an independent Python
    /// (`cryptography`) derivation from the RFC's private keys.
    #[test]
    fn rfc8291_example() {
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(
            &d("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"),
            &d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
            &d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            &d("BTBZMqHH6r4Tts7J_aSIgg"),
            &salt,
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        let mut expected = d("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
        expected.extend(d(
            "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
        ));
        assert_eq!(body, expected);
    }

    #[test]
    fn encrypt_rejects_bad_keys_and_big_payloads() {
        let rng = rng();
        let ua = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        assert_eq!(
            encrypt(&ua[..64], &auth, b"x", &rng),
            Err(PushError::BadKey)
        );
        assert_eq!(
            encrypt(&ua, &auth[..15], b"x", &rng),
            Err(PushError::BadKey)
        );
        let mut not_on_curve = ua.clone();
        not_on_curve[64] ^= 1;
        assert_eq!(
            encrypt(&not_on_curve, &auth, b"x", &rng),
            Err(PushError::BadKey)
        );
        assert_eq!(
            encrypt(&ua, &auth, &vec![0; MAX_PLAINTEXT + 1], &rng),
            Err(PushError::TooLarge)
        );
        let body = encrypt(&ua, &auth, b"hello", &rng).unwrap();
        assert_eq!(body.len(), 16 + 4 + 1 + 65 + 5 + 1 + 16);
        assert_eq!(&body[16..21], &[0, 0, 16, 0, 65]);
    }

    #[test]
    fn vapid_header_verifies_with_its_public_key() {
        let rng = rng();
        // A known P-256 key pair: the sender keys of the RFC 8291 example.
        let private = d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        let public = d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
        let value = vapid_authorization(
            &private,
            &public,
            "https://web.push.apple.com",
            1_800_000_000,
            "mailto:a@b.example",
            &rng,
        )
        .unwrap();
        let rest = value.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        let (input, sig) = jwt.rsplit_once('.').unwrap();
        Verify::new(&ECDSA_P256_SHA256_FIXED, d(k))
            .verify(input.as_bytes(), &d(sig))
            .unwrap();
        let (h, c) = input.split_once('.').unwrap();
        assert_eq!(d(h), br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims: serde_json::Value = serde_json::from_slice(&d(c)).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["exp"], 1_800_000_000u64);
        assert_eq!(claims["sub"], "mailto:a@b.example");
        assert_eq!(d(k), public);
        let mut other = public.clone();
        other[64] ^= 1;
        assert_eq!(
            vapid_authorization(&private, &other, "https://x", 1, "mailto:a@b", &rng),
            Err(PushError::BadKey)
        );
        assert_eq!(
            vapid_authorization(&private[..31], &public, "https://x", 1, "mailto:a@b", &rng),
            Err(PushError::BadKey)
        );
    }

    #[test]
    fn base64url_round_trips_and_is_strict() {
        for n in 0..40u8 {
            let data: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(unb64url(&b64url(&data)).unwrap(), data);
        }
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
        assert!(unb64url("a").is_none()); // impossible length
        assert!(unb64url("ab=c").is_none()); // padding/other chars
        assert!(unb64url("ab+/").is_none()); // standard alphabet
        assert!(unb64url("AB").is_none()); // non-zero leftover bits
        assert_eq!(unb64url("AA").unwrap(), vec![0]);
    }
}
