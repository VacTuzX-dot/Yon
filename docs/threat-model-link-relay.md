## Threat Model: Yon Link relay (ADR-003)

Scope: phones reaching a computer through the WebSocket relay. The sealed Yon
Link protocol itself is covered by threat-model-yon-link.md.

### Assets

- File contents and pairing keys (must stay unreadable to the relay)
- The computer's availability through its room
- The relay host (meox): bandwidth, CPU, reputation

### Actors

| Actor | Trust | Notes |
| ----- | ----- | ----- |
| Relay operator | Untrusted for content | Sees metadata only |
| Anyone on the internet | Untrusted | Can reach the relay |
| Paired phone | Low | Holds K and the room id |
| Controller of the Pages repo | Trusted (supply chain) | Serves the page's code |

### Threats (STRIDE)

| Threat | STRIDE | Mitigation |
| ------ | ------ | ---------- |
| Relay reads or changes files | I/T | Every request/reply AEAD-sealed with the per-session key from K; relay only forwards bytes |
| Stranger joins a room and talks to the computer | S | Room id alone gets nothing: `/hello` needs a known pair id, everything after needs K |
| Someone takes over a room to pose as the computer | S/D | Serving a room needs `R` with `SHA-256(R)` = room id; one computer per room; phones verify every reply with K anyway |
| Relay used as free bandwidth / flood | D | Frame size cap (≈1.1 MiB), per-connection and per-IP rate limits, connection caps, idle timeouts, rooms exist only while a computer is connected |
| Malicious page served from GitHub Pages | S/I/E | CI-only deploys from tagged commits, SRI on the script, branch protection; residual: repo compromise |
| Metadata exposure (IPs, timing, sizes) | I | Accepted; documented; self-hostable relay |
| Replay through the relay | T | Existing replay window per session |

### Residual risks

- The relay operator learns who uses Yon Link with whom, when and how much.
- Whoever controls the Pages repository controls the page's code.

### Controls required

- [ ] Relay tests: secret check, one computer per room, size/rate limits, timeouts
- [ ] Desktop feature off by default; clear status in Settings
- [ ] Page build pinned (SRI) and deployed only by CI
