# One phone, many computers: computer list + "Add computer" scan

**Status:** Approved and implemented (2026-10-09). Not built yet: offline
computers greyed in "Send to" (only online ones are listed) and remembering
the last choice.
**Target release:** v0.2.5
**Builds on:** ADR-001 (Yon Link), ADR-003 (relay), ADR-004 (QR decoding)
**Phase:** 1 of 2 — pairings made with "Reach from anywhere" only

v1 of this spec handed the phone from one computer to another over the
desktop TLS channel. Review (Atlas, 2026-10-09) showed that scanning the new
computer's QR from inside the Yon icon gives the same result without any new
computer ↔ computer protocol and with a stronger trust anchor (the QR is on
the real computer's screen). v1 is dropped; see "Rejected" below.

## Problem

A phone can pair with one computer per Home Screen icon:

- The phone page keeps a single pairing: `STORE = "yon-link-pairing"`
  (`web/link.ts:21`). Opening a second computer's link overwrites it
  (`web/link.ts:38`).
- The Home Screen icon remembers the URL it was saved from; the fragment is
  the source of truth (`web/link.ts:34-39`). Each computer = its own icon.
- iOS gives a Home Screen web app its own storage, separate from Safari.
  Scanning a computer's QR with the Camera app opens Safari, so the icon
  never sees the new pairing.

## Goal

One Yon icon on the phone sends to and receives from every computer the
user owns. Adding a computer = tap **Add computer** in the icon, scan that
computer's normal pairing QR.

## Decisions

1. **The phone page keeps a list of computers** ("keyring"). Every pairing
   that reaches the page (fragment or scan) is added; nothing is replaced.
2. **Scan inside the icon.** "Add computer" opens the camera in the page,
   reads the QR that **Settings → Phones → Pair a phone** already shows, and
   adds that pairing. Nothing changes on the computer.
3. **Native first.** Use `BarcodeDetector` where the browser has it (Android
   Chrome). Otherwise decode with a small pinned library running in a
   dedicated Worker, which cannot read `localStorage` (ADR-004).
4. **Each computer keeps its own pairing** (own pair id, key, room). Removing
   the phone on one computer doesn't affect the others.
5. **Phase 1 is relay pairings only.** "Add computer" exists only on the
   HTTPS page (`https://yon.meo.in.th/phonelink/`), and only accepts relay
   links for that page. LAN-only links (`http://<host>:53421/#…`) are
   rejected with "Turn on Reach from anywhere on that computer, then show the
   code again". LAN pages are unchanged (one computer each) — Phase 2.

Unchanged: Rust backend, desktop UI, relay, Yon Link crypto and protocol,
pairing QR format.

## Phone page

### Keyring (`web/keyring.ts`, new, pure)

- `localStorage["yon-link-computers"]`: JSON array of pairing strings in the
  fragment grammar `<pair id>.<key>.<room>@<relay host>` (relay) or
  `<pair id>.<key>` (LAN page only), max **4**, deduplicated by pair id.
- `localStorage["yon-link-forgotten"]`: pair ids the user removed (max 32,
  oldest dropped), so a forgotten pairing that is baked into the icon's
  fragment stays gone.
- Load: fragment pairing (if present and not forgotten) first, then the
  keyring. A fragment pairing missing from the keyring is added — so the
  existing "scan with Camera, open link" path also accumulates now.
- Migration: an existing `yon-link-pairing` value is added once, then the
  old key is removed.
- Full (4): "Add computer" says "This phone can keep 4 computers. Forget one
  first." Cap reason: one relay WebSocket per computer and the relay allows
  16 per IP (`relay/relay.ts:31`); 4 × (stale + new after a resume) = 8.
- Storage blocked (private mode): today's behaviour (fragment only);
  "Add computer" is hidden.
- Exports: `parsePairing(s)`, `mergeKeyring(list, add)`,
  `forget(list, forgotten, id)`, `loadComputers(hash, storage)` — all pure,
  storage injected, unit-tested.

### Accepting a scanned code (`parseScanned`)

Input: the QR's text. Accept only if **all** hold, else show "This isn't a
Yon code for this phone page":

1. Parses as a URL with scheme `https:`.
2. `origin + pathname` equals this page's `location.origin + location.pathname`
   (so a code for another page or host is never stored here).
3. Fragment matches the relay grammar exactly (same regex as
   `readPairing`, `web/link.ts:32`).

A LAN-only link (`http:`) gets the specific "Turn on Reach from anywhere"
message instead. The pairing is then added to the keyring and a session to
the new computer starts at once; its `/hello` proves the key, which completes
the computer's own pending pairing exactly as a first Camera-app scan does.

### Camera and decoder (`web/scan.ts`, `web/qr-worker.ts`, new)

- `navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })`
  into a `<video playsinline muted>` inside a new `#scan` section, with a
  Cancel button. Stream tracks are stopped on success, Cancel, `pagehide`,
  and when the section closes — the camera is never left on.
- Every ~150 ms: if `BarcodeDetector` with `qr_code` is available, call it
  on the video; otherwise draw a downscaled frame (longest side ≤ 640 px) to
  a canvas and post its `ImageData` to the worker. One frame in flight.
- `qr-worker.ts` imports the decoder and only does
  `onmessage = ({data}) => postMessage(decode(data))`. It receives pixels
  and returns a string; it has no access to `localStorage` and the page
  never sends it a pairing.
- Permission denied / no camera: "Yon can't use the camera. Allow it in
  Settings → Safari (or your browser), or scan the code with the Camera
  app and open the link in Safari."
- Text only via `textContent` (existing rule, `web/link.ts:4`).

### Sessions

One `Session` and one `RelayTransport` per computer. Each runs its own
`/inbox` long-poll. On `pagehide`, close every relay WebSocket so the relay
frees the slot at once instead of after its 60 s idle timeout
(`relay/relay.ts:34`); they reopen on the next request (`web/transport.ts:72`).

### UI

- **One computer:** unchanged, plus a small **Add computer** link under the
  file picker.
- **Several:** the existing "Send to" chooser (`#choose` / `#targets`) lists
  every computer first (offline ones greyed), then phones reachable through
  each, labelled "via <computer>". Last choice remembered per phone.
- Incoming offers name the sending computer.
- `/hello` → 404 (`Gone`) for one computer: its row shows "Removed on
  <name> · Forget". If it was the only computer: today's message
  (`web/link.ts:266`).
- **Computers** list (from the header): name, online state, Forget.

## Server headers (camera is blocked today)

Both servers send `Permissions-Policy: camera=()`, which disables
`getUserMedia` for the page:

- `website/serve.ts:47` → for paths under `/phonelink/` send
  `camera=(self), microphone=(), geolocation=()`; every other path keeps
  `camera=()`.
- `src-tauri/src/link/http.rs:209` (LAN page) stays `camera=()` — no scan
  there in Phase 1.

CSP needs no change: `default-src 'self'` already covers a same-origin
worker script; `srcObject` media streams aren't fetched. Verify both on
iPhone Safari and Android Chrome before shipping.

## Build (`scripts/build-link.ts`)

Add `web/qr-worker.ts` as a second entrypoint → `qr-worker.js`, copied next
to `link.js` in both outputs. Worker scripts can't use SRI; integrity rests
on the same-origin, CI-only deploy that already protects `link.js`.

## Security

### Threat model: in-page QR scanning + keyring

**Assets:** all pairings on the phone (≤ 4 keys + rooms); camera access.

| Threat | STRIDE | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Hostile QR (on a poster, another screen) adds an attacker computer to the phone | S | Low | Med: attacker can offer files (user must tap Receive) and receive what the user chooses to send to it | User must tap Add computer and aim at a code; new computer appears by its own name in the list; same exposure as scanning any Yon QR with the Camera app today |
| Malformed QR text breaks the page or injects markup | T | Low | Low | `parseScanned` exact grammar + same-origin check; `textContent` only |
| QR decoder library is malicious or compromised | I/E | Low | High: could read pairings if it ran in the page | Runs only in a dedicated Worker: no `localStorage`, no DOM, never given a key; exact version pinned, `bun.lock` committed, reviewed source vendored via the bundle; Android uses native `BarcodeDetector` |
| Decoder bug (crash, hang) on crafted image | D | Low | Low | Worker isolated; one frame in flight; Cancel kills the worker |
| Camera left running | I | Low | Med (privacy) | Tracks stopped on success/Cancel/`pagehide`/close; camera allowed only on `/phonelink/` |
| XSS on the origin reads every pairing | I/E | Low | High | Unchanged controls (`script-src 'self'`, no third-party code in the page context, CI-only deploys); blast radius grows from 1 to ≤ 4 computers — accepted |
| Relay per-IP connection cap hit by several computers | D | Low | Low | Cap 4; close sockets on `pagehide` |

**Residual risks:** a user who scans a stranger's Yon code adds that
computer (they can Forget it); all pairings share one origin.

**Controls before shipping:** `parseScanned` tests (wrong origin, wrong
path, http LAN link, bad grammar, extra characters); keyring tests; camera
stopped on every exit path; Permissions-Policy scoped to `/phonelink/`
(serve test); worker receives only `ImageData`.

## Testing

- `bun test web/`: `keyring.test.ts` (merge, dedupe, cap 4, forget +
  fragment, migration, blocked storage), `parseScanned` cases above.
- `bun test website/`: `/phonelink/` gets `camera=(self)`, `/` keeps
  `camera=()`.
- Manual (real devices): iPhone Home Screen icon and Android Chrome
  installed page, two computers with Reach from anywhere on: add the second
  by scan, send to each, receive from each, remove the phone on one
  computer → "Removed on … · Forget", camera indicator off after every exit.

## Rejected

| Option | Why |
|---|---|
| v1: computer A hands a new pairing from B to the phone (desktop TLS frames, prompt on B, short code) | 6 commits across Rust and UI; A and B must share a LAN and A must be on; the code shown on A and the phone matches even when A reached a look-alike B (review finding) |
| Hub: one computer forwards to the others | That computer must always be on; files cross twice |
| Keyring only, keep scanning with the Camera app | iOS opens Safari, not the icon — doesn't fix the problem on iPhone |
| Paste a link into the page | Long hex string; no easy way to move it from a Windows PC to an iPhone |

## Out of scope (Phase 2 or later)

- LAN-only pairings in the same list (one origin per computer).
- Showing the same phone once across computers in "via" lists.
- "Remove from all computers".

## Open questions

1. Assumption to verify: `getUserMedia` works inside an iOS Home Screen web
   app on current iOS, and doesn't re-prompt every launch in a way that
   makes scanning painful.
2. Assumption to verify: iOS keeps a Home Screen app's `localStorage`
   (WebKit counts only days the app is used toward its 7-day limit).
3. Library choice and version: ADR-004.

## Implementation steps (one commit each, after approval)

1. ADR-004 accepted, dependency added (Hard Stop: confirm first).
2. `web/keyring.ts` + tests; `web/link.ts` uses it (several sessions,
   chooser, Forget, `pagehide` close). No camera yet — the Camera-app path
   already accumulates computers on Android.
3. `web/scan.ts`, `web/qr-worker.ts`, `#scan` UI, build entrypoint,
   Permissions-Policy for `/phonelink/` + tests.
4. Docs: `docs/yon-link.md` ("Add another computer"), `docs/security.md`,
   threat model file, README feature line.
