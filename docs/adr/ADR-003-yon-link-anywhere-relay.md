# ADR-003: Yon Link from anywhere through a blind WebSocket relay

**Status:** Proposed
**Date:** 2026-09-28

## Context

Yon Link (ADR-001) only works when the phone and the computer share a LAN.
The maintainer wants it to work across networks, like Blip. That needs
something on the internet both sides can reach.

Spike results (2026-09-27/28, details in the agent log):

- iroh 1.x in the browser is relay-only. With iroh's default relay URLs WebKit
  never connects (trailing-dot FQDN, iroh #4519/#4550); undotted URLs fix it.
- n0's public relays cap throughput at ~1 MiB/s. A local relay gave Chromium
  7–15 MiB/s and Safari on macOS 5–7 MiB/s.
- **iroh-wasm on an iPhone ran at ~0.2 MiB/s whatever relay was used**, while
  Yon Link's own crypto (@noble/ciphers) runs at 120–200 MB/s on the same phone.

So iroh is the wrong tool for phones today, and computer ↔ computer across
networks isn't asked for yet.

## Decision

Carry the existing Yon Link protocol over a small relay:

1. **Relay** (`relay/`, Bun, no dependencies): WebSocket rooms. A computer
   connects with a room secret `R` and serves room `SHA-256(R)`; phones connect
   to that room id. The relay forwards frames between them and keeps nothing:
   no storage, no accounts, no database. One computer per room.
2. **Computer**: when "Reach from anywhere" is on, keeps one outbound WebSocket
   to the relay and feeds each frame into the same `Link` request handler the
   LAN listener uses (same AEAD sessions, admission gate, offers, relay-between-
   phones). Nothing new is opened on the computer's network.
3. **Page**: served over HTTPS from GitHub Pages. The QR / Home Screen URL
   becomes `https://<pages>/#<pair_id>.<K>.<room_id>`. The page talks to the
   relay; requests and replies are the same sealed messages as on the LAN.
4. **Relay hosting**: the maintainer's server (meox) behind Cloudflare. The
   relay URL is a setting, so anyone can run their own.

## Consequences

### Positive

- Works across Wi-Fi, 4G, anywhere; one Home Screen icon.
- The page is HTTPS: a secure context, so a LAN attacker can no longer swap the
  page's JavaScript to steal K — the main residual risk of ADR-001 goes away
  for this path.
- The relay can't read or forge anything (every request/reply is AEAD-sealed
  with the phone's session key); it only sees metadata.
- Reuses almost all of Yon Link; the relay is ~100 lines.

### Negative / Trade-offs

- Someone must run the relay (meox), and its bandwidth caps transfers.
- Always relayed, even at home (an HTTPS page can't call the computer's
  `http://` LAN address). The LAN page stays for full speed at home.
- The page code now comes from GitHub Pages: whoever controls that repo
  controls the page. Mitigation: deployed only by CI from tagged commits;
  Subresource Integrity on the script; branch protection.
- The relay sees who talks to whom, when, and how much.
- One more dependency on the desktop: a WebSocket client (`tokio-tungstenite`).

## Alternatives Considered

| Option | Why rejected |
|--------|-------------|
| iroh (native + wasm) | ~0.2 MiB/s from iPhone browsers in the spike; large dependency and wasm/llvm toolchain |
| n0 public relays | ~1 MiB/s cap, "development and hobby use only" |
| Tailscale | Needs an app and an account on every device |
| WebRTC between phone and computer | Needs signalling anyway, complex NAT story in browsers, harder to audit |
| Hosted file storage (Blip-style cloud) | Stores user files; accounts and a database |

## Implementation steps (one commit each, after approval)

1. `relay/` Bun server + tests (rooms, secret check, frame and rate limits).
2. Desktop: outbound WebSocket client feeding `Link`; setting "Reach from
   anywhere" (off by default) with the relay URL.
3. Page: relay transport next to fetch; build for GitHub Pages with SRI.
4. Pairing QR carries the room id; docs, threat model update.
5. Deploy relay on meox (maintainer) and test on iPhone over 4G.
