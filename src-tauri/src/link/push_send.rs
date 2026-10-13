//! Web Push sender: one encrypted, VAPID-signed POST per offer to a paired
//! phone's push service. Spec: docs/superpowers/specs/2026-10-13-phone-push-design.md.
//!
//! The subscription comes from a paired phone, so it is untrusted input: the
//! endpoint must be a known push service (otherwise this computer would be an
//! SSRF proxy). Errors never carry the endpoint or key material.

use super::push::{self, unb64url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;

/// Contact in the VAPID `sub` claim (RFC 8292 allows an https URL): the
/// project page, so no email address is published. A build may override it.
pub const SUBJECT: &str = match option_env!("YON_PUSH_CONTACT") {
    Some(s) => s,
    None => "https://yon.meo.in.th",
};
const MAX_ENDPOINT: usize = 1024;
const JWT_LIFETIME_SECS: u64 = 12 * 60 * 60;
/// The offer lives 10 minutes; a newer offer replaces an undelivered one.
const TTL_SECS: u32 = 600;
const TOPIC: &str = "yon-offer";
const MIN_GAP: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE: usize = 16 * 1024;

/// A phone's Web Push subscription plus the VAPID key pair it subscribed with.
/// Base64url strings; `vapid_d` is the private scalar (JWK `d`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushSub {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub vapid_d: String,
    pub vapid_pub: String,
}

/// Debug shows only the push host: the keys are secrets and must never reach a log.
impl fmt::Debug for PushSub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let host = endpoint_parts(&self.endpoint).map_or("<invalid>", |(h, _)| h);
        f.debug_struct("PushSub")
            .field("host", &host)
            .field("endpoint", &"<redacted>")
            .field("p256dh", &"<redacted>")
            .field("auth", &"<redacted>")
            .field("vapid_d", &"<redacted>")
            .field("vapid_pub", &"<redacted>")
            .finish()
    }
}

/// What a phone's push subscription became, as told to the settings owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushChange {
    /// The phone subscribed (or re-subscribed).
    Set(PushSub),
    /// The phone turned push off.
    Clear,
    /// The push service said this endpoint is gone (404/410). Clears only
    /// if it is still the stored endpoint: a newer subscription is kept.
    GoneIf(String),
}

/// `(host, path)` of an endpoint on an allowed push service, `None` otherwise.
/// Hosts: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, any
/// `<label>.push.apple.com` and `<label>.notify.windows.com`.
pub fn endpoint_parts(endpoint: &str) -> Option<(&str, &str)> {
    if endpoint.len() > MAX_ENDPOINT || !endpoint.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return None;
    }
    let rest = endpoint.strip_prefix("https://")?;
    let slash = rest.find('/')?;
    let (host, path) = rest.split_at(slash);
    let lower = host.to_ascii_lowercase();
    let labels_ok = lower
        .split('.')
        .all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    let allowed = lower == "fcm.googleapis.com"
        || lower == "updates.push.services.mozilla.com"
        || lower
            .strip_suffix(".push.apple.com")
            .is_some_and(|l| !l.is_empty())
        || lower
            .strip_suffix(".notify.windows.com")
            .is_some_and(|l| !l.is_empty());
    (labels_ok && allowed).then_some((host, path))
}

/// Shape and allowlist checks on a subscription from a paired phone. The
/// VAPID pair is checked by `ring`, which refuses a private key that doesn't
/// match its public key.
pub fn validate(s: &PushSub) -> bool {
    if endpoint_parts(&s.endpoint).is_none() {
        return false;
    }
    let (Some(p256dh), Some(auth), Some(d), Some(public)) = (
        unb64url(&s.p256dh),
        unb64url(&s.auth),
        unb64url(&s.vapid_d),
        unb64url(&s.vapid_pub),
    ) else {
        return false;
    };
    p256dh.len() == 65
        && p256dh[0] == 0x04
        && auth.len() == 16
        && d.len() == 32
        && public.len() == 65
        && public[0] == 0x04
        && push::vapid_authorization(&d, &public, "https://x", 1, SUBJECT, &push::rng()).is_ok()
}

/// The payload shown on the phone: no file names, only who and how many.
pub fn payload(from: &str, files: usize) -> Vec<u8> {
    json!({ "t": "offer", "from": from, "n": files })
        .to_string()
        .into_bytes()
}

/// Builds the POST for `sub`: returns `(host, request bytes)`.
pub fn build_request(sub: &PushSub, payload: &[u8], now: u64) -> Result<(String, Vec<u8>), String> {
    let (host, path) = endpoint_parts(&sub.endpoint).ok_or("endpoint refused")?;
    let (Some(ua), Some(auth), Some(d), Some(public)) = (
        unb64url(&sub.p256dh),
        unb64url(&sub.auth),
        unb64url(&sub.vapid_d),
        unb64url(&sub.vapid_pub),
    ) else {
        return Err("bad subscription keys".into());
    };
    let rng = push::rng();
    let body = push::encrypt(&ua, &auth, payload, &rng).map_err(|e| format!("encrypt: {e:?}"))?;
    let audience = format!("https://{host}");
    let vapid = push::vapid_authorization(
        &d,
        &public,
        &audience,
        now + JWT_LIFETIME_SECS,
        SUBJECT,
        &rng,
    )
    .map_err(|e| format!("vapid: {e:?}"))?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nTTL: {TTL_SECS}\r\nUrgency: high\r\n\
         Topic: {TOPIC}\r\nContent-Encoding: aes128gcm\r\n\
         Content-Type: application/octet-stream\r\nContent-Length: {}\r\n\
         Authorization: {vapid}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut request = head.into_bytes();
    request.extend_from_slice(&body);
    Ok((host.to_string(), request))
}

/// How one push ended, for logs.
#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Delivered,
    /// 404/410: the subscription is gone; `on_gone` was called.
    Gone,
    Failed(String),
}

/// Sends one push through `post(host, request) -> status`. `on_gone` runs
/// when the push service says the subscription no longer exists.
pub async fn push_once<F, Fut>(
    sub: &PushSub,
    payload: &[u8],
    now: u64,
    post: F,
    on_gone: impl FnOnce(),
) -> Reply
where
    F: FnOnce(String, Vec<u8>) -> Fut,
    Fut: Future<Output = Result<u16, String>>,
{
    let (host, request) = match build_request(sub, payload, now) {
        Ok(r) => r,
        Err(e) => return Reply::Failed(e),
    };
    match post(host, request).await {
        Ok(200..=299) => Reply::Delivered,
        Ok(404 | 410) => {
            on_gone();
            Reply::Gone
        }
        Ok(code) => Reply::Failed(format!("HTTP {code}")),
        Err(e) => Reply::Failed(e),
    }
}

/// At most one push per phone per 30 s.
#[derive(Default)]
pub struct PushLimiter(Mutex<HashMap<[u8; 16], Instant>>);

impl PushLimiter {
    /// True (and recorded) if this phone wasn't pushed to within 30 s.
    pub fn allow(&self, phone: [u8; 16], now: Instant) -> bool {
        let mut last = self.0.lock().expect("lock");
        if last
            .get(&phone)
            .is_some_and(|t| now.saturating_duration_since(*t) < MIN_GAP)
        {
            return false;
        }
        last.insert(phone, now);
        true
    }
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The real transport: HTTP/1.1 POST over TLS (platform roots), 10 s limit.
/// Returns the status code only.
pub async fn send_https(host: String, request: Vec<u8>) -> Result<u16, String> {
    tokio::time::timeout(IO_TIMEOUT, exchange(&host, &request))
        .await
        .map_err(|_| "push service timed out".to_string())?
}

async fn exchange(host: &str, request: &[u8]) -> Result<u16, String> {
    use rustls_platform_verifier::BuilderVerifierExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // WHY: ring passed explicitly and the OS trust store for the push
    // service's certificate, the same setup as the relay client.
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .and_then(|b| b.with_platform_verifier())
    .map_err(|_| "TLS setup failed".to_string())?
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| "bad push host".to_string())?;
    let tcp = TcpStream::connect((host, 443))
        .await
        .map_err(|e| format!("connect failed: {}", e.kind()))?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|_| "TLS with push service failed".to_string())?;
    tls.write_all(request)
        .await
        .map_err(|e| format!("write failed: {}", e.kind()))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = tls
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read failed: {}", e.kind()))?;
        if n == 0 {
            return Err("no response from push service".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut resp = httparse::Response::new(&mut headers);
        if let Ok(httparse::Status::Complete(_)) = resp.parse(&buf) {
            return resp
                .code
                .ok_or_else(|| "bad response from push service".to_string());
        }
        if buf.len() > MAX_RESPONSE {
            return Err("response from push service too large".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::push::b64url;
    use crate::link::push::unb64url as d;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
    use std::cell::RefCell;

    // RFC 8291 §5 receiver key and auth secret (a valid subscription).
    const UA_PUB: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    // A valid P-256 key pair (the RFC 8291 sender key).
    const VAPID_D: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const VAPID_PUB: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const NOW: u64 = 1_800_000_000;

    fn sub() -> PushSub {
        PushSub {
            endpoint: "https://web.push.apple.com/abc123".into(),
            p256dh: UA_PUB.into(),
            auth: AUTH.into(),
            vapid_d: VAPID_D.into(),
            vapid_pub: VAPID_PUB.into(),
        }
    }

    fn with_endpoint(e: &str) -> PushSub {
        PushSub {
            endpoint: e.into(),
            ..sub()
        }
    }

    #[test]
    fn debug_output_hides_keys() {
        let s = sub();
        let out = format!("{s:?}");
        assert!(out.contains("web.push.apple.com"));
        for secret in [UA_PUB, AUTH, VAPID_D, VAPID_PUB, "abc123"] {
            assert!(!out.contains(secret), "Debug leaked {secret}");
        }
    }

    #[test]
    fn valid_subscription_passes() {
        assert!(validate(&sub()));
    }

    #[test]
    fn accepted_push_hosts() {
        for host in [
            "web.push.apple.com",
            "api.push.apple.com",
            "fcm.googleapis.com",
            "updates.push.services.mozilla.com",
            "wns2-par02p.notify.windows.com",
        ] {
            let e = format!("https://{host}/send/xyz");
            assert!(validate(&with_endpoint(&e)), "{host} should pass");
        }
    }

    #[test]
    fn refused_endpoints() {
        let long = format!("https://fcm.googleapis.com/{}", "a".repeat(1024));
        for e in [
            "http://web.push.apple.com/x",
            "https://web.push.apple.com.evil.example/x",
            "https://push.apple.com/x",
            "https://evilpush.apple.com/x",
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://fcm.googleapis.com:8443/x",
            "https://user@fcm.googleapis.com/x",
            "https://fcm.googleapis.com",
            "https://fcm.googleapis.com?x=1",
            "https://fcm.googleapis.com/a b",
            "https://fcm.googleapis.com/a\r\nHost: evil",
            "https://.push.apple.com/x",
            "https://a..push.apple.com/x",
            "https:///x",
            "https://example.com/x",
            long.as_str(),
        ] {
            assert!(!validate(&with_endpoint(e)), "{e:?} should be refused");
        }
    }

    #[test]
    fn refused_key_shapes() {
        let with = |f: fn(&mut PushSub)| {
            let mut s = sub();
            f(&mut s);
            s
        };
        assert!(
            !validate(&with(|s| s.p256dh = b64url(&[0x04; 64]))),
            "p256dh 64 bytes"
        );
        assert!(
            !validate(&with(|s| s.p256dh = b64url(&[0x05; 65]))),
            "p256dh no 0x04"
        );
        assert!(
            !validate(&with(|s| s.auth = b64url(&[7; 15]))),
            "auth 15 bytes"
        );
        assert!(
            !validate(&with(|s| s.auth = b64url(&[7; 17]))),
            "auth 17 bytes"
        );
        assert!(
            !validate(&with(|s| s.vapid_d = b64url(&[7; 31]))),
            "vapid_d 31 bytes"
        );
        assert!(
            !validate(&with(|s| s.vapid_pub = b64url(&[0x04; 64]))),
            "vapid_pub 64 bytes"
        );
        assert!(
            !validate(&with(|s| s.vapid_pub = b64url(&[0x05; 65]))),
            "vapid_pub no 0x04"
        );
        assert!(
            !validate(&with(|s| s.vapid_d = "!!".into())),
            "not base64url"
        );
    }

    #[test]
    fn refused_mismatched_vapid_pair() {
        // A valid point, but not the public key of VAPID_D.
        let mut s = sub();
        s.vapid_pub = UA_PUB.into();
        assert!(!validate(&s));
    }

    #[test]
    fn payload_has_no_file_names() {
        let v: serde_json::Value = serde_json::from_slice(&payload("Leo's Mac", 3)).unwrap();
        assert_eq!(v, json!({ "t": "offer", "from": "Leo's Mac", "n": 3 }));
    }

    #[test]
    fn request_has_exact_headers_and_body_length() {
        let (host, request) = build_request(&sub(), b"{}", NOW).unwrap();
        assert_eq!(host, "web.push.apple.com");
        let (head, body) = request
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| (&request[..i + 4], &request[i + 4..]))
            .unwrap();
        let head = std::str::from_utf8(head).unwrap();
        let mut lines = head.split("\r\n");
        assert_eq!(lines.next().unwrap(), "POST /abc123 HTTP/1.1");
        assert_eq!(lines.next().unwrap(), "Host: web.push.apple.com");
        assert_eq!(lines.next().unwrap(), "TTL: 600");
        assert_eq!(lines.next().unwrap(), "Urgency: high");
        assert_eq!(lines.next().unwrap(), "Topic: yon-offer");
        assert_eq!(lines.next().unwrap(), "Content-Encoding: aes128gcm");
        assert_eq!(
            lines.next().unwrap(),
            "Content-Type: application/octet-stream"
        );
        assert_eq!(
            lines.next().unwrap(),
            format!("Content-Length: {}", body.len())
        );
        let auth = lines.next().unwrap();
        let auth = auth.strip_prefix("Authorization: vapid t=").unwrap();
        assert_eq!(lines.next().unwrap(), "Connection: close");
        assert_eq!(lines.next(), Some(""));
        assert_eq!(lines.next(), Some(""));
        // The body is a single aes128gcm record: header (21 bytes) + record.
        assert_eq!(body.len(), 16 + 4 + 1 + 65 + 2 + 1 + 16);

        // The JWT verifies with the phone's public key and has the right audience.
        let (jwt, k) = auth.split_once(", k=").unwrap();
        assert_eq!(d(k).unwrap(), d(VAPID_PUB).unwrap());
        let (input, sig) = jwt.rsplit_once('.').unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, d(k).unwrap())
            .verify(input.as_bytes(), &d(sig).unwrap())
            .unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&d(input.split_once('.').unwrap().1).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["exp"], NOW + 12 * 60 * 60);
        assert_eq!(claims["sub"], SUBJECT);
    }

    #[test]
    fn request_path_follows_endpoint() {
        let s = with_endpoint("https://fcm.googleapis.com/fcm/send/AbC-_1?x=2");
        let (host, request) = build_request(&s, b"{}", NOW).unwrap();
        assert_eq!(host, "fcm.googleapis.com");
        assert!(request.starts_with(b"POST /fcm/send/AbC-_1?x=2 HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn push_once_posts_to_host_and_reports_delivery() {
        let seen = RefCell::new(None);
        let gone = RefCell::new(false);
        let reply = push_once(
            &sub(),
            b"{}",
            NOW,
            |host, req| {
                *seen.borrow_mut() = Some((host, req));
                async { Ok(201) }
            },
            || *gone.borrow_mut() = true,
        )
        .await;
        assert_eq!(reply, Reply::Delivered);
        assert!(!*gone.borrow());
        assert_eq!(seen.borrow().as_ref().unwrap().0, "web.push.apple.com");
    }

    #[tokio::test]
    async fn gone_subscription_is_reported_for_clearing() {
        for code in [404u16, 410] {
            let cleared = RefCell::new(0);
            let reply = push_once(
                &sub(),
                b"{}",
                NOW,
                |_, _| async move { Ok(code) },
                || *cleared.borrow_mut() += 1,
            )
            .await;
            assert_eq!(reply, Reply::Gone, "status {code}");
            assert_eq!(*cleared.borrow(), 1, "status {code} must clear");
        }
    }

    #[tokio::test]
    async fn other_failures_do_not_clear_and_carry_no_endpoint() {
        let cleared = RefCell::new(false);
        let reply = push_once(
            &sub(),
            b"{}",
            NOW,
            |_, _| async { Ok(500) },
            || *cleared.borrow_mut() = true,
        )
        .await;
        assert_eq!(reply, Reply::Failed("HTTP 500".into()));
        assert!(!*cleared.borrow());

        let reply = push_once(
            &sub(),
            b"{}",
            NOW,
            |_, _| async { Err("connect failed: refused".to_string()) },
            || panic!("must not clear on a transport error"),
        )
        .await;
        match reply {
            Reply::Failed(msg) => {
                assert!(!msg.contains("web.push.apple.com"));
                assert!(!msg.contains(VAPID_D));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn refused_endpoint_never_reaches_the_network() {
        let reply = push_once(
            &with_endpoint("https://127.0.0.1/x"),
            b"{}",
            NOW,
            |_, _| async { Err("must not connect".to_string()) },
            || {},
        )
        .await;
        assert_eq!(reply, Reply::Failed("endpoint refused".into()));
    }

    #[test]
    fn limiter_allows_one_push_per_30_seconds_per_phone() {
        let limiter = PushLimiter::default();
        let t0 = Instant::now();
        assert!(limiter.allow([1; 16], t0));
        assert!(!limiter.allow([1; 16], t0 + Duration::from_secs(29)));
        assert!(
            limiter.allow([2; 16], t0 + Duration::from_secs(29)),
            "per phone"
        );
        assert!(limiter.allow([1; 16], t0 + Duration::from_secs(30)));
    }
}
