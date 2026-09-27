## Threat Model: Yon Link (paired web page for phones)

See ADR-001 for why this exists. Scope: v2 — phone → computer, computer →
phone, and phone ↔ phone relayed by the computer.

### 1. Assets

- Integrity of the receiving computer's disk (what gets written, where, how much)
- Confidentiality of file contents while on the Wi-Fi
- Per-phone pairing keys (in the phone's saved URL and in the desktop settings file)
- The desktop user's attention (Accept dialogs)
- Files the desktop user offers to a phone (must reach only that phone)
- Relayed files while they sit on the computer
- The phone's memory while receiving

### 2. Trust Boundaries

- LAN (untrusted: other people on the same Wi-Fi) → Yon Link listener on the computer
- Page JavaScript (served by Yon, over http) → phone browser storage and file picker
- Link listener → shared receive gate → disk (same boundary as the desktop protocol)

### 3. Actors

| Actor | Trust Level | Notes |
| ----- | ----------- | ----- |
| Paired phone (holds key K) | Low trust | Can *ask* to send; the desktop user still accepts unless the phone is trusted |
| Stranger on the Wi-Fi | Untrusted | Can reach the port; has no K |
| Active network attacker (ARP spoofing, rogue AP) | Untrusted, capable | Can alter unencrypted http responses |
| Someone who sees the QR / Home Screen URL | Untrusted | Gains K |
| Local desktop user | Trusted | Owns settings and the Accept decision |

### 4. Attack Surface

- TCP port 53421 on all IPv4 interfaces (private source addresses only), open only while at least one phone is paired
- `GET /` and static assets (no secrets; K is never sent to the server)
- `GET /hello?p=<pair_id>`, `POST /request`, `POST /chunk`, `POST /status`, `POST /done`, `POST /cancel`, `POST /inbox`, `POST /pull`, `POST /offer/{accept,decline,done,cancel}`, `POST /peers` — all but `/` and `/hello` require a valid AEAD session
- QR code and saved Home Screen URL (contain K in the fragment)

### 5. Threats (STRIDE)

| Threat | STRIDE | Likelihood | Impact | Mitigation |
| ------ | ------ | ---------- | ------ | ---------- |
| Stranger on the Wi-Fi pushes files | S | Med | High | Every request after `/hello` is AEAD-sealed with a key derived from K; unknown `pair_id` and bad tags get identical 404s; Accept dialog unless trusted |
| Passive sniffing of file contents | I | High (public Wi-Fi) | High | ChaCha20-Poly1305 per session; HKDF-SHA256 from K with fresh server and client nonces |
| Replay or reorder of captured chunks | T | Low | Med | Per-direction counters in nonce and AAD; strictly increasing; session bound to route + session id |
| Truncating a file (drop last chunks) | T | Low | Med | Chunk index and total in AAD; `/done` checks count and size before commit |
| Active MITM replaces page JS and steals K | S/I | Low | High | **Residual** (no secure context on http). Mitigated by: UI label "web link — less protected than the app", per-phone revocation, Accept dialog |
| Leaked QR / screenshot / synced bookmark | S | Med | Med | Holder can only request; Accept still required; "Remove phone" invalidates K immediately |
| Connection flood, slowloris, huge headers/bodies | D | Med | Med | Private-IP filter, connection cap, 8 KiB/32-header limit, Content-Length only, 1 MiB+overhead body cap, header and idle timeouts, one transfer at a time, disk-space check |
| Unauthenticated `/hello` spam to create sessions | D | Med | Low | Session table cap + per-IP rate limit; sessions expire after 5 min idle |
| Path traversal / reserved / bidi file names | T/S | Med | High | Same `sanitize_file_name` and `clean_display` as the desktop protocol |
| Cross-site request from another page on the phone | S | Low | Low | Requests need K-derived AEAD; strict CSP, no CORS headers |
| K stolen from the desktop settings file | I | Low | Med | Same exposure as the identity key file (user-level); TECH DEBT: OS keychain |
| Disk fill via many accepted transfers | D | Low | Med | Free-space check per request; user must accept each untrusted request |
| Out-of-order parallel requests abused for replay | T | Low | Med | 64-counter sliding window per direction: each counter once; window moves only after a message opens |
| A phone reads files offered to another phone, or desktop files not offered | I | Low | High | Offers are keyed by the phone id of the authenticated session; `/pull` only takes indexes into that offer (range-checked, `checked_mul`); paths never come from the phone |
| Paired phone A pushes unwanted files to phone B | S/D | Med | Low | B sees who sends and must accept; only paired phones with the page open; one offer per phone; ≤ 1000 MiB |
| Relayed files left on the computer | I/D | Low | Med | Stored under the app data folder (not Downloads, never opened), same free-space check and one-transfer-at-a-time slot; deleted when the offer completes, is declined, cancelled or expires, when the upload is cancelled, and at startup |
| Listing other phones | I | Low | Low | `/peers` only for authenticated sessions; returns names and a fingerprint-derived handle, never pairing ids or keys |
| Phone memory exhaustion while receiving | D | Med | Low | Offers capped at 1000 MiB (tested on iPhone); a Blob per chunk; chunk length checked |
| Unanswered or stalled offers pile up | D | Low | Low | One offer per phone; unaccepted offers expire after 10 min, stalled ones after the session idle time |

### 6. Residual Risks

- Active MITM on the LAN can capture K by injecting JavaScript — accepted for v1: plain http can't prevent it; stated in UI and README; revocation available. The desktop ↔ desktop protocol (mutual TLS) is unaffected.
- A trusted ("always accept") phone whose K leaks can write files without prompting until removed — same as a trusted desktop device; users choose trust per phone.
- Phone ↔ phone relays don't ask the desktop user; any paired phone can offer files to any other paired phone that has Yon open. Accepted: the owner paired both phones, and the receiving phone decides.
- A leaked K also lets its holder receive files the desktop user offers to that phone. Offers are started by the desktop user for a named phone; "Remove phone" revokes K.

### 7. Controls Required (before shipping)

- [ ] AEAD on every post-hello request and response; identical 404 for unknown pair and bad tag
- [ ] Counter-based nonces; replay and reorder tests
- [ ] HTTP limits (header size/count, body size, timeouts) with tests
- [ ] Listener only while a phone is paired or pairing is shown; private-IP filter; connection cap
- [ ] Shared receive gate (validate, sanitize, cooldown, disk, busy, Accept) used by both protocols
- [ ] "Remove phone" deletes K and closes its sessions
- [ ] UI label and README note about the weaker protection
- [ ] Strict security headers on every response (CSP `default-src 'self'`, no inline script, `no-store`, `no-referrer`, `nosniff`)
- [x] v2: sliding replay window with tests on both sides (mutation-checked)
- [x] v2: offers bound to the authenticated phone; range-checked pulls; tests for decline, cancel both sides, expiry, removed phone
- [x] v2: relay folder lifecycle tests (completed, cancelled upload); desktop UI not involved
