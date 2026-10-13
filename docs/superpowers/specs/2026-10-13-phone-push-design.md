# Phone push notifications: "Leo's MacBook wants to send you 3 files"

**Status:** Draft v2 (2026-10-13), after Atlas review; awaiting approval
**Builds on:** ADR-001 (Yon Link), ADR-003 (relay), 2026-10-09 phone-many-computers
**Threat model:** `docs/threat-model-phone-push.md`

## Goal

When a computer offers files to a phone whose Yon page is closed, the phone
shows a system notification. Tapping it opens the Yon Home Screen app, where
the offer is waiting (or received automatically, if auto-receive is on).

## Decisions

1. **The computer sends the push itself**, straight to the phone's push
   service (Apple, Google, Mozilla, Microsoft). The relay is unchanged and
   learns nothing new.
2. **The phone owns the VAPID key.** A push subscription is bound to one
   `applicationServerKey` and a service worker has one subscription, so
   computers can't each use their own key. The phone generates one P-256 key
   pair, subscribes with its public key, and gives the subscription plus the
   private key to each paired computer over the sealed Yon Link session. Any
   of its computers can then sign the VAPID JWT for this phone, and only for
   this phone.
3. **Relay (HTTPS) pages only.** Push needs a secure context; the
   home-Wi-Fi page is `http://`. Its computers keep working without push.
4. **No new dependencies.** Desktop crypto uses `ring` (P-256 ECDH, ECDSA
   P-256 SHA-256, HKDF-SHA-256, AES-128-GCM, CSPRNG); HTTPS uses the existing
   `tokio-rustls` + `rustls-platform-verifier` with a small HTTP/1.1 POST
   (`httparse` for the response). Base64url is a few lines.
5. **Minimal service worker:** `push` and `notificationclick` only. No
   `fetch` handler, no caching, so page-code updates and the page's security
   model are unchanged.
6. **The notification never names files.** Title: computer (or sending
   phone) name; body: "wants to send you 3 files". Encrypted end to end
   (RFC 8291), but kept minimal anyway.

## Flow

```
Phone (Yon app)                         Computer                         Push service
"Notify me when files arrive" (tap)
Notification.requestPermission()
generate VAPID key pair (WebCrypto, stored on the phone)
pushManager.subscribe({userVisibleOnly, applicationServerKey: vapid pub})
for each computer:
  sealed POST /push/subscribe  ──────►  validate endpoint + keys
  {endpoint, p256dh, auth, vapid}       store on that phone's pairing
                                         …
                                         offer to phone (Link::add_offer)
                                         encrypt payload (RFC 8291)
                                         sign VAPID JWT (RFC 8292)
                                         POST endpoint  ───────────────►  deliver
sw.js: push → showNotification ◄──────────────────────────────────────────────
tap → notificationclick → focus/open /phonelink/ → /inbox shows the offer
```

## Phone page (`web/`)

- `web/push.ts` (new, pure where possible):
  - `canPush()`: secure context, `serviceWorker`, `PushManager`, `Notification`,
    and (iOS) running as a Home Screen app (`display-mode: standalone`).
  - `enablePush(computers)`: called from a tap. Request permission → register
    `sw.js` (scope `./`) → load or create the VAPID key (`ECDSA P-256`,
    extractable, stored as JWK `d`/`x`/`y` base64url in `localStorage["yon-push"]`; the computer gets `vapid_d` + `vapid_pub`)
    → `pushManager.subscribe` with `applicationServerKey` as a `Uint8Array`
    (WebKit needs a BufferSource) (reuse an existing subscription if its
    `applicationServerKey` matches) → `POST /push/subscribe` to every online
    computer.
  - When a computer is added later (Add computer), and push is enabled, send
    it the same subscription.
  - **Forget with push on → rotate:** best-effort `POST /push/unsubscribe` to
    the forgotten computer, then a new VAPID key, a new subscription, and
    `/push/subscribe` to every remaining computer. The forgotten computer's
    copy of the old key and endpoint becomes useless.
  - `disablePush()`: `subscription.unsubscribe()`, `POST /push/unsubscribe`
    to every computer, remove the stored key.
- `web/sw.ts` → `sw.js` (built next to `link.js`, `/phonelink/` only):
  - `install`/`activate`: `skipWaiting()` and `clients.claim()`, so a fixed
    `sw.js` takes over at once (iOS Home Screen apps otherwise keep a waiting
    worker).
  - `push`: always show a notification (`userVisibleOnly: true` requires it:
    Chrome otherwise shows a generic one and Safari revokes the subscription
    after a few silent pushes); when a `/phonelink/` client is visible, show it
    with `silent: true`. Parse `{"t":"offer","from":…,"n":…}`; `showNotification(from,
    { body: "wants to send you N files", tag: "yon-offer", icon: "icon.png",
    data: { url: "./" } })`. Bad payload → generic "Yon: files are waiting".
  - `notificationclick`: close; focus an existing `/phonelink/` client, else
    `clients.openWindow("./")`.
- `manifest.webmanifest`: `name` "Yon", `start_url` "./", `scope` "./",
  `display` "standalone", icons (192/512 from the existing logo). Linked from
  `link.html` (relay page only; the LAN page doesn't get it).
- UI: Computers screen → **Notify me when files arrive** (on/off). On iPhone
  outside the Home Screen app: hint "Add Yon to your Home Screen first".
  Denied permission: hint to allow it in Settings → Notifications → Yon.
- Headers: `website/serve.ts` serves `sw.js` with
  `Content-Type: text/javascript` and `Service-Worker-Allowed` not needed
  (default scope). CSP unchanged (`default-src 'self'` covers the worker and
  the manifest).

## Computer (`src-tauri/src/link/`)

### Sealed routes (`link/mod.rs`)

- `POST /push/subscribe` body
  `{"endpoint": str, "p256dh": b64url, "auth": b64url, "vapid": b64url}`:
  validate (below), store on that phone's `PairedPhone`, save settings.
  Reply `{"result":"ok"}` or `{"result":"invalid"}`.
- `POST /push/unsubscribe`: clear it.

### Validation (trust boundary: a paired phone is low-trust input)

- `endpoint`: ≤ 1024 bytes, parses as a URL, scheme `https`, no userinfo,
  default port only, host in the allowlist:
  `*.push.apple.com` (Apple uses several gateways), `fcm.googleapis.com`,
  `updates.push.services.mozilla.com`, and `*.notify.windows.com`.
  Anything else is refused (SSRF: otherwise a phone could make the computer
  POST to an address on its LAN or anywhere).
- `p256dh`: 65 bytes, first byte `0x04`, a valid P-256 point (ring rejects
  invalid points at agreement time; check at subscribe by a trial agreement).
- `auth`: exactly 16 bytes.
- `vapid`: PKCS#8 of an ECDSA P-256 key that `ring` loads.

### Storage (`settings.rs`)

`PairedPhone` gains `#[serde(default)] push: Option<PushSub>` with
`{ endpoint: String, p256dh: String, auth: String, vapid: String }` (base64url).
`settings.json` is already owner-only (0600). Removing the phone removes it.
`Settings::load` drops a `push` entry that no longer validates.

### Sending (`link/push.rs`, new)

- Trigger: `Link::add_offer` (computer → phone and phone → phone relays),
  after the offer is stored, if that phone has `push`. Always sent: an
  "online" check (`seen` within 35 s) would skip phones locked moments ago;
  the service worker shows it silently when the page is visible.
  Spawned, never blocks or fails the offer; errors are logged
  (`[yon] push: <status>` without the endpoint URL).
- Payload: `{"t":"offer","from":<name>,"n":<file count>}`, ≤ 3 KB.
- Encryption: RFC 8291 `aes128gcm` (ephemeral P-256 ECDH with `p256dh`,
  HKDF with `auth`, 16-byte random salt, record size 4096, single record,
  padding delimiter `0x02`).
- VAPID: RFC 8292 JWT `{"aud": <endpoint origin>, "exp": now+12h,
  "sub": "mailto:<project contact>"}` (Apple rejects a JWT without a usable
  `sub`; `mailto:` is the form every push service accepts`, ES256 with the phone's key;
  header `Authorization: vapid t=<jwt>, k=<public key b64url>`.
- Request headers: `TTL: 600` (the offer lives 10 min), `Urgency: high`,
  `Topic: yon-offer` (a newer offer replaces an undelivered one),
  `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`.
- HTTP: one HTTPS/1.1 POST per push over `tokio-rustls` with the platform
  verifier, 10 s timeout. `404`/`410` → the subscription is gone: clear it
  and save. Other errors: log only.
- Rate limit: at most one push per phone per 30 s (offers are already one at
  a time per phone).

### Tests (Rust)

- RFC 8291 §5 test vector reproduces the exact ciphertext (fixed salt and
  ephemeral key injected in a test-only constructor).
- VAPID JWT verifies with the public key; header/claims exact.
- Endpoint allowlist: accepted hosts; refused http, other hosts, IP literals,
  `user@host`, non-default port, `web.push.apple.com.evil.example`, length.
- Key validation: wrong lengths, missing `0x04`, invalid PKCS#8.
- 410 response clears the subscription (HTTP layer behind a trait, mocked).

## Testing on devices

- iPhone (iOS 16.4+) Home Screen app: enable → close app → send from the
  computer → notification → tap opens Yon with the offer.
- Android Chrome installed app: same.
- Icons added before the manifest existed: does push work, or must the user
  re-add to the Home Screen? Record the result in docs.
- Relay-only: home-Wi-Fi page shows no push option.

## Open questions

1. ~~HTTP/1.1 acceptance~~ — checked 2026-10-13: an HTTP/1.1 POST to
   `https://web.push.apple.com/` returns `403 {"reason":"BadAuthorizationHeader"}`
   (a Web Push error, so HTTP/1.1 is accepted); `fcm.googleapis.com` answers
   HTTP/1.1 too. No `h2` needed.
2. iOS: do icons added before the manifest existed get push, or must they be
   re-added to the Home Screen?

## Rejected

| Option | Why |
|---|---|
| Relay sends the pushes (Atlas review) | The relay would store subscriptions and a VAPID key and learn when offers happen — against ADR-003 ("keeps nothing"); new server state and a dependency there |
| Each computer its own VAPID key | One subscription per service worker, bound to one key: only one computer could push |
| Push only when the phone is "offline" | `seen` lasts 35 s, so a phone locked moments ago would get nothing; the SW shows it silently when visible instead (never hidden: userVisibleOnly) |

## Out of scope

- Push for the home-Wi-Fi page.
- Notifications for anything other than an incoming offer.
- Notification actions (Receive / Decline buttons in the notification).

## Implementation steps (each reviewed separately)

1. Rust: `link/push.rs` crypto (RFC 8291 + VAPID) with the RFC test vector —
   written by the coordinator, reviewed line by line.
2. Rust: validation + settings field + routes + tests (haiku).
3. Rust: HTTPS sender + trigger in `add_offer` + 404/410 handling (haiku,
   reviewed).
4. Web: `sw.ts`, manifest, `push.ts`, Computers toggle, build + headers
   (haiku).
5. Docs: `docs/yon-link.md`, `docs/security.md`, threat model status.
