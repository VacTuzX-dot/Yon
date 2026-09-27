## Threat Model: LocalSend compatibility (ADR-002)

Scope: Yon speaking LocalSend protocol v2 over HTTPS on the LAN, when the user
has turned on "Work with LocalSend". Off by default.

### 1. Assets

- Files on the computer (integrity: nothing written without the user's say)
- File contents in transit (confidentiality)
- The LocalSend private key (P-256) in the app data folder
- The user's trust list (who is auto-accepted)
- Disk space, CPU, open connections

### 2. Trust Boundaries

- LAN (untrusted) → UDP 53317 multicast listener
- LAN (untrusted) → HTTPS server on TCP 53317
- Yon (client) → a LocalSend device's HTTPS server, reached via an address and
  fingerprint learned from untrusted multicast
- Rust core → webview (unchanged: opaque ids, no paths)

### 3. Actors

| Actor | Trust Level | Notes |
| ----- | ----------- | ----- |
| LocalSend device with a client certificate | Low trust | Identity = cert fingerprint; can be auto-accepted only if the user chose so |
| LocalSend device without a client certificate | Untrusted | Can only ask; always needs Accept; labelled "not verified" |
| Stranger on the Wi-Fi | Untrusted | Can send multicast and reach port 53317 |
| Active network attacker (ARP spoofing, rogue AP) | Untrusted, capable | Can forge announcements and intercept first contact |
| Local desktop user | Trusted | Enables the feature, accepts transfers |

### 4. Attack Surface

- UDP multicast listener (announcements, replies)
- `POST /api/localsend/v2/register`, `GET /api/localsend/v2/info`
- `POST /api/localsend/v2/prepare-upload`, `/upload`, `/cancel`
- Outgoing HTTPS to addresses taken from announcements (`register`, `prepare-upload`, `upload`)

### 5. Threats (STRIDE)

| Threat | STRIDE | Likelihood | Impact | Mitigation |
| ------ | ------ | ---------- | ------ | ---------- |
| Stranger pushes files | S | Med | High | Every request goes through `Receiver::admit`; Accept dialog unless the sender's **certificate** fingerprint is trusted; no auto-accept without a client cert |
| Spoofed alias ("Mom's iPhone") | S | Med | Med | Dialog shows the fingerprint-derived device code and the "LocalSend" / "not verified" label; alias is display-only and cleaned with `clean_display` |
| Forged announcement makes Yon send files to an attacker | S/I | Low | High | Send only after the user picks the device and confirms; TLS pinned to the announced fingerprint; first-contact impersonation is **residual** (same as LocalSend itself) |
| Announcement makes Yon connect to arbitrary hosts (SSRF-like) | T | Med | Low | Only private IPv4 source addresses; we connect to the packet's source IP (not an address in the JSON) and a port in 1024–65535; `register` rate-limited per peer; small timeouts |
| Passive sniffing | I | High | High | HTTPS only (TLS 1.3/1.2 via rustls); HTTP-mode peers ignored |
| Upload with a stolen/guessed token | S | Low | High | 128-bit random tokens per file, constant-time compare, bound to session + sender IP + (if present) cert fingerprint; session ends on cancel/finish/timeout |
| Body larger than announced / truncated | T | Med | Med | Stream stops at the announced size (extra bytes = failure); short body = failure; `.yonpart` removed by `Reserved` drop |
| Wrong content | T | Low | Med | SHA-256 computed while streaming; compared with `sha256` when given (422 on mismatch) |
| Path traversal / reserved / bidi names | T/S | Med | High | Same `sanitize_file_name` + `clean_display` as Yon; file ids are opaque to us |
| Huge JSON / many files / deep nesting | D | Med | Med | prepare-upload body ≤ 1 MiB; same file-count and total-size limits as Yon; serde with typed structs |
| Slowloris / connection flood / chunked abuse | D | Med | Med | hyper HTTP/1.1 with header read timeout, max header size, connection cap, per-request idle timeout, private-IP filter; one transfer at a time |
| Multicast flood | D | Med | Low | Packet size cap (4 KiB), per-source rate limit, peer table cap with expiry |
| Parallel uploads to exhaust disk or handles | D | Low | Med | Free-space check covers the whole session at admission; each file id can be uploaded once; at most 4 files in flight per session (the LocalSend app uses 2), more get 409 |
| LocalSend private key stolen from disk | I | Low | Med | Same exposure as Yon's identity key (user-level file); TECH DEBT: OS keychain |
| Feature listens when the user doesn't expect it | E | Low | Med | Off by default; Settings shows it's on; port-in-use shown, no silent fallback |

### 6. Residual Risks

- First contact with a LocalSend device can be impersonated by an active LAN
  attacker (fingerprints come from unauthenticated multicast). Accepted: same
  as LocalSend and as Yon's own mDNS discovery; the user still confirms every
  send and every untrusted receive.
- Senders without a client certificate can't be identified; they can never be
  auto-accepted.
- Protocol owned upstream; behaviour may change.

### 7. Controls Required (before shipping)

- [ ] Off by default; toggle in Settings; port-busy message
- [ ] HTTPS only; ignore `protocol: "http"` peers
- [ ] Separate P-256 identity; fingerprint = SHA-256(cert DER) uppercase hex
- [ ] Client pins the server cert to the announced fingerprint
- [ ] Server: optional client cert → fingerprint; trust only by cert fingerprint
- [ ] All receives through `Receiver::admit`; `Reserved` files; streaming SHA-256; size enforced
- [ ] Tokens 128-bit, constant-time compare, bound to session + IP
- [ ] hyper limits: header timeout, max headers, connection cap, body caps for JSON routes
- [ ] Multicast: private-IPv4 sources only, size cap, rate limit, table cap
- [ ] Integration tests: fake LocalSend sender and receiver (with and without client cert, bad token, oversize, sha mismatch, cancel)
- [ ] Manual test against the real LocalSend app on iPhone and Android
