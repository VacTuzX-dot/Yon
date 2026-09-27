# ADR-001: Serve a paired web page for phones instead of native mobile apps

**Status:** Accepted
**Date:** 2026-09-27

## Context

Yon runs on macOS and Windows. Users also want to send photos and files from
iPhones and Android phones. Distributing a native iOS app to anyone but the
developer requires a paid Apple Developer account (TestFlight and the App Store
both need it); Android needs APK sideloading. The maintainer wants the easiest
path for himself and for users, with no cloud service and no database.

A spike on an iPhone (iOS 18.7, Safari and Brave) showed that `yon-<id>.local`
resolves on the LAN, that a Home Screen icon keeps the full URL including its
`#fragment`, and that chunked uploads from a page opened from the icon work.

## Decision

We will have the desktop app serve a small web page on the LAN (Yon Link). A
phone pairs once by scanning a QR code that carries a per-phone key in the URL
fragment, adds the page to its Home Screen, and afterwards taps the icon to send
files to that computer. Because the page is plain `http://` (no secure context),
confidentiality comes from application-level ChaCha20-Poly1305 with a
per-session key derived from the pairing key, not from TLS.

Version 1 is phone → computer only.

## Consequences

### Positive

- Works on any phone with a browser: no App Store, no fee, no sideloading.
- One Rust receiving pipeline: the same validation, name sanitizing, busy/cooldown
  gate, disk checks and Accept dialog as the desktop protocol.
- No cloud and no database; paired phones live in the local settings file.

### Negative / Trade-offs

- Weaker than the desktop protocol: an attacker who can actively tamper with
  LAN traffic can replace the page's JavaScript and steal the pairing key.
  Passive sniffing is covered. The UI says so, and phones can be removed.
- The page must stay open while sending (iOS suspends hidden pages); uploads
  resume but don't continue in the background. No "Share → Yon" from phone apps.
- Computer → phone is deferred: it needs in-browser decryption into memory.
- A fixed port (53421) so saved icons keep working; if it's taken, Link is
  unavailable until it's free.

## Alternatives Considered

| Option | Why rejected |
| ------ | ------------ |
| Native iOS app (Tauri mobile) | Needs a paid Apple Developer account to reach anyone but the developer |
| Android APK only | Leaves iPhone users out; sideloading friction |
| Page hosted on Vercel | An https page can't call `http://192.168.x.x` (mixed content, Private Network Access); a relay would add cloud + state |
| WebRTC with a signaling server | Needs cloud infrastructure and shared state |
| HTTPS with Yon's self-signed cert | Browser shows a full-page security warning on every visit |
| Plain http without app-level encryption | Anyone on the Wi-Fi could read the files |
