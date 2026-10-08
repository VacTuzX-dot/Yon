## Threat Model: one phone, several computers (v0.2.5)

Scope: the Yon icon on a phone keeping up to 4 computers, adding one by scanning its pairing QR inside the page, and the camera used for that scan. Phase 1: pairings made with Reach from anywhere (relay) only. Builds on the relay model (threat-model-link-relay.md) and the Yon Link model (threat-model-yon-link.md). Decision: [ADR-004](adr/ADR-004-phone-qr-decoding.md).

### Assets

- Pairing keys and rooms for up to 4 computers, all stored on the phone
- Camera access (the phone page only)
- The user's files sent to or received from those computers

### Actors

| Actor | Trust | Notes |
| ----- | ----- | ----- |
| The phone's owner | Trusted | Taps Add computer and chooses what to aim at |
| Holder of a stranger's Yon QR (poster, another screen) | Untrusted | Can offer a computer the user did not own |
| Author of the QR decoder (jsQR) | Untrusted until reviewed | Its code runs only in a Worker with no storage access |
| Anyone on the internet | Untrusted | Can reach the relay and the phone page |
| Whoever controls the website deploy (yon.meo.in.th) and CI | Trusted (supply chain) | Deploys the page and worker code via `.github/workflows/website.yml` from tagged commits |

### Threats (STRIDE)

| Threat | STRIDE | Likelihood | Impact | Mitigation |
| ------ | ------ | ---------- | ------ | ---------- |
| Hostile QR (poster, another screen) adds an attacker computer to the phone | S | Low | Medium: the attacker can offer files (the user must tap Receive) and receive what the user chooses to send to it | The user must tap Add computer and aim at a code. The new computer appears by its own name in the list. Same exposure as scanning any Yon QR with the Camera app today |
| Malformed QR text breaks the page or injects markup | T | Low | Low | Exact relay grammar check and same-origin check in `parseScanned`; text is set with `textContent` only |
| QR decoder library is malicious or compromised | I/E | Low | High: could read pairings if it ran in the page | Runs only in a dedicated Worker: no `localStorage`, no DOM, never given a key. Exact version pinned, `bun.lock` committed, source reviewed (ADR-004). Android uses the native `BarcodeDetector` and no library |
| Decoder bug (crash, hang) on a crafted image | D | Low | Low | Worker is isolated; one frame in flight; Cancel stops the scan |
| Camera left running | I | Low | Medium (privacy) | Tracks stopped on success, Cancel, `pagehide` and when the section closes. Camera allowed only on `/phonelink/` |
| XSS on the origin reads every pairing | I/E | Low | High | Unchanged controls: `script-src 'self'`, no third-party code in the page context, CI-only deploys. Blast radius grows from 1 computer to up to 4. Accepted |
| Relay per-IP connection cap hit by several computers | D | Low | Low | Cap of 4 computers; relay WebSockets closed on `pagehide` so the slot frees at once |

### Residual risks

- A user who scans a stranger's Yon code adds that computer. They can remove it with Forget.
- All pairings share one origin. A page compromise reaches every stored key.
- Worker scripts cannot carry SRI. Their integrity relies on the same-origin, CI-only deploy, as `link.js` does today.
- Forget removes a computer from the phone only. The phone stays paired on that computer until it is removed there.

### Controls

- `parseScanned` accepts only `https:` links for this exact origin and path, with the exact relay fragment grammar. Other links get a specific message (Wi-Fi-only) or "This isn't a Yon pairing code."
- The keyring caps the list at 4, deduplicates by pair id, and keeps a list of forgotten pair ids so a baked-in fragment does not bring a removed computer back.
- The decoder worker receives only `ImageData` and returns text. It is never given a pairing.
- `Permissions-Policy: camera=(self)` only on `/phonelink/`; `camera=()` on every other path and on the LAN page.

### Still to verify on devices

- `getUserMedia` works in an iOS Home Screen web app and does not re-prompt on every launch (spec, open question 1).
- iOS keeps a Home Screen app's `localStorage` across the 7-day limit for unused apps (spec, open question 2).
- `BarcodeDetector` is absent on current iOS Safari (ADR-004 follow-up).
