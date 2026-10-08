# ADR-004: Decoding pairing QR codes inside the phone page

**Status:** Accepted (2026-10-09)
**Date:** 2026-10-09

## Context

To keep one Yon icon for several computers, the phone page must read a
computer's pairing QR itself (spec 2026-10-09-phone-many-computers). Scanning
with the Camera app opens Safari, whose storage iOS keeps apart from the
Home Screen app.

- Android Chrome has `BarcodeDetector` (QR supported). No dependency needed.
- iOS Safari does not ship `BarcodeDetector` (verify on current iOS before
  merging). Decoding there needs code.
- The page's origin holds every pairing key in `localStorage`. Any
  third-party code running in the page context could read them.

## Decision

1. `BarcodeDetector` when available.
2. Otherwise **jsQR** (Apache-2.0, pure JavaScript, no dependencies), exact
   version pinned in `package.json`, `bun.lock` committed, bundled at build
   time into `qr-worker.js`.
3. The decoder runs only inside a **dedicated Worker** that receives
   `ImageData` and returns text. Workers have no `localStorage` and no DOM,
   and the page never posts a key to it, so a compromised decoder can't
   reach pairings.
4. Before adding: read the pinned version's source for network, storage and
   `eval`/`Function` use; record the reviewed version and SHA-512 from
   `bun.lock` here.

## Consequences

### Positive

- One small, pure decoder; camera handling stays in our code.
- Supply-chain blast radius contained by the Worker boundary.
- No CSP change (`default-src 'self'` covers the same-origin worker).

### Negative / Trade-offs

- jsQR has had no release for years. Acceptable: QR is a stable format and
  the code is a pure function; a fork or vendored copy is the fallback.
- `qr-worker.js` is 131,294 bytes minified (measured 2026-10-09), more than
  first estimated; jsQR carries text-decoding tables. It loads only when
  Add computer is tapped on a browser without `BarcodeDetector` (iOS);
  `link.js` doesn't grow.
- Worker scripts can't carry SRI; integrity relies on same-origin CI-only
  deploys, like `link.js` on the server today.

## Alternatives considered

| Option | Why rejected |
|---|---|
| `qr-scanner` (nimiq) | Bundles camera handling and its own worker loader we'd have to audit too; we only need the decoder |
| `zxing-wasm` / `barcode-detector` polyfill | WebAssembly (~1 MB) and needs `'wasm-unsafe-eval'` in CSP |
| Write our own QR decoder | Large, error-prone, nothing to gain |
| No in-page scan (Camera app only) | Doesn't work on iPhone — the reason for this ADR |

## Review record (2026-10-09)

- Version: `jsqr@1.4.0`, Apache-2.0, pinned exact in `package.json`.
- `bun.lock` integrity: `sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==`
- No runtime dependencies; npm scripts are build/watch only (no install hooks).
- `dist/jsQR.js`: no `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`,
  `postMessage`, `localStorage`, `indexedDB`, `eval`, `new Function`,
  `document.`, `window.`, `self.` or `globalThis` (grep, 0 matches).

## Follow-up

- [ ] Confirm `BarcodeDetector` absence on current iOS Safari (device test).
