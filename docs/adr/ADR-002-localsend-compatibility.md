# ADR-002: Speak the LocalSend protocol (v2) alongside Yon's own

**Status:** Deferred (2026-09-27): the maintainer wants Yon to be the only app
on every device. Phones get computer → phone and phone ↔ phone through Yon
Link instead (see ADR-001). Kept for the research; revisit if native mobile
apps stay out of reach.
**Date:** 2026-09-27

## Context

Yon moves files between computers with its own protocol (mutual TLS 1.3,
pinned Ed25519 keys, mDNS). Phones can send to a computer through Yon Link
(ADR-001), but they can't receive, and phones can't reach each other at all.
Native mobile apps are out of reach for now (paid Apple account, sideloading).

[LocalSend](https://github.com/localsend/localsend) is a free, open-source app
for iOS, Android, macOS, Windows and Linux that does LAN file transfer with a
documented REST protocol ([v2.2](https://github.com/localsend/protocol)).
If Yon speaks that protocol, a phone with LocalSend installed can send to and
receive from a computer running Yon, and phones already talk to each other
through LocalSend itself.

What the current LocalSend core (Rust, `packages/core`) does, read from source
on 2026-09-27:

- Discovery: JSON announcements on UDP multicast `224.0.0.167:53317`; peers
  answer with `POST /api/localsend/v2/register` to the announcer (UDP reply as
  fallback). Announcements carry `fingerprint`, `port` and `protocol`.
- Transport: HTTPS on port 53317 with a self-signed certificate (RSA-2048,
  `CN=LocalSend User`, never expires). The fingerprint is the SHA-256 of the
  certificate DER, uppercase hex.
- Server authentication: the client pins the server certificate to the
  fingerprint it learned in discovery (`PinnedServerCertVerifier`).
- Client authentication: the server asks for a client certificate and derives
  the sender's fingerprint from it; the JSON `fingerprint` is ignored in HTTPS
  mode. It is optional only when LocalSend's own web share is on.
- Upload: `prepare-upload` (metadata, receiver decides, returns `sessionId` and a
  token per file) → one `upload?sessionId&fileId&token` request per file with a
  **streamed body** (reqwest `wrap_stream`, so chunked transfer encoding, no
  Content-Length) → optional `sha256` check → `cancel`. The app uploads **two
  files at once** (`_concurrency = 2` in `upload_isolate.dart`).
- Also has an HTTP (no TLS) mode, an optional PIN, a reverse "download" API
  for browsers, and a `v3` that is not wired up yet.

## Decision

Yon will implement LocalSend protocol **v2, HTTPS only**, as an optional second
transport that is **off by default** (Settings → "Work with LocalSend"):

1. **Separate identity.** A new ECDSA P-256 key and self-signed certificate
   used only for LocalSend, stored next to the Yon identity. The LocalSend
   fingerprint is SHA-256(cert DER), uppercase hex. Yon's Ed25519 identity and
   trust list are not reused, so the two trust domains never mix.
2. **Discovery.** Join `224.0.0.167:53317` on IPv4, announce on enable and
   every few minutes, answer announcements via `register` (HTTPS, pinned to the
   announced fingerprint) with UDP as fallback. LocalSend peers appear in the
   device list with a "LocalSend" label. Peers in HTTP mode are ignored.
3. **Receiving.** HTTPS server on TCP 53317 (rustls, client certificate
   requested but optional). `prepare-upload` goes through the same
   `Receiver::admit` gate as every other transport (validation, file-name
   sanitising, free space, one transfer at a time, cooldown, Accept dialog).
   Within an accepted session, files may arrive in parallel (up to 4 at once);
   each streams into its own `Reserved` `.yonpart` file, hashed as it goes, and
   is checked against `sha256` when the sender gave one. Tokens are 128-bit
   random, compared in constant time, and bound to the sender's IP.
4. **Trust.** A sender that presented a client certificate is identified by
   that certificate's fingerprint, and "Always accept" is allowed for it (the
   same trust-on-first-use as Yon devices). A sender without a certificate is
   labelled "not verified" and must be accepted every time.
5. **Sending.** HTTPS client pinned to the announced fingerprint, presenting
   Yon's LocalSend certificate, `prepare-upload` then one streamed `upload` per
   file with Content-Length. A PIN-protected receiver gets a clear error in v1.
6. **HTTP framing.** Use `hyper` 1.x (server + client, HTTP/1.1 only) with
   `hyper-util` and `http-body-util`. All three are already in `Cargo.lock`
   through the updater. We need streamed chunked bodies from untrusted peers,
   and a mature parser is safer than growing Yon Link's minimal one. No HTTP/2:
   ALPN offers only `http/1.1`.

Not in scope for v1: HTTP mode, PIN entry, the download API, protocol v1/v3,
IPv6, folders.

## Consequences

### Positive

- Phones (iOS and Android, free app) can send to **and receive from** Yon
  computers; phone ↔ phone already works inside LocalSend.
- No new crates to trust beyond making three existing transitive ones direct.
- Every transfer still passes the one admission gate, so size limits, name
  sanitising, quarantine flags and the Accept dialog apply unchanged.

### Negative / Trade-offs

- A second listener (TCP 53317) and a multicast socket when enabled. Port
  53317 clashes with the LocalSend desktop app on the same computer; Yon shows
  that instead of silently picking another port (peers expect 53317).
- LocalSend's identity is weaker than Yon's in practice: fingerprints are
  learned from unauthenticated multicast, so the very first contact can be
  impersonated by an active attacker on the LAN (Yon's mDNS has the same
  first-contact limit). Senders without a client certificate can't be
  identified at all.
- The protocol is owned by another project; changes upstream can break us.
  Mitigation: target the documented v2, test against the real app before each
  release.
- More code to maintain: discovery, server and client for a second protocol.

### Neutral

- Yon Link stays for phones that won't install an app.
- Desktop ↔ desktop between Yon installs keeps using Yon's own protocol.

## Alternatives Considered

| Option | Why rejected |
|--------|-------------|
| Do nothing; tell users to install LocalSend on every device | Yon computers would be invisible to LocalSend phones |
| Computer → phone over Yon Link (v2 of ADR-001) | Browser has to decrypt in memory; iOS limits; no phone ↔ phone |
| Reuse Yon's Ed25519 key for LocalSend | Mixes trust domains; older LocalSend clients may not accept Ed25519 certificates |
| Support LocalSend HTTP mode too | Plain text on the LAN; violates secure > fast > lite |
| Extend Yon Link's HTTP parser for chunked streaming bodies | Hand-rolled parsing of untrusted chunked bodies is riskier than hyper |
| WebRTC phone ↔ phone through the computer | Needs the computer on anyway; untested on iOS http pages |

## References

- LocalSend protocol v2.2: https://github.com/localsend/protocol
- LocalSend core source (`packages/core/src/http`, `crypto/cert.rs`)
- Threat model: [docs/threat-model-localsend.md](../threat-model-localsend.md)
- ADR-001 (Yon Link)
