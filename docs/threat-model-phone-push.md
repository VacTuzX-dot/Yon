## Threat Model: phone push notifications

Scope: a computer sending Web Push notifications to a paired phone when it
offers files (spec `docs/superpowers/specs/2026-10-13-phone-push-design.md`).
Builds on the Yon Link, relay and phone-computers threat models.

### Assets

- The phone's push subscription (endpoint + `p256dh` + `auth`) and the
  phone-owned VAPID private key: together they allow sending notifications to
  that phone.
- The computer's network position (it must not become a proxy into the LAN).
- Metadata: who sends to whom and when.
- The phone page's origin (`yon.meo.in.th/phonelink/`), which holds every
  pairing key.

### Trust boundaries

- Phone → computer: sealed Yon Link session (AEAD with the pairing key);
  the content is attacker-controlled if the phone is.
- Computer → push service: HTTPS on the public internet.
- Push service → phone: the OS push channel; payload encrypted for the phone.
- Service worker ↔ page: same origin.

### Actors

| Actor | Trust | Notes |
| ----- | ----- | ----- |
| Paired phone | Low | Can send any `/push/subscribe` body |
| Paired computer | Trusted by the phone's owner | Holds the phone's subscription and VAPID key |
| Push service (Apple, Google, Mozilla, Microsoft) | Untrusted for content | Sees endpoint, timing, size; can't read the payload |
| Relay operator | Untrusted | Sees only sealed bytes, as today |
| Someone who reads a computer's `settings.json` | Untrusted | Already gets the pairing keys today |
| Controller of the website deploy | Trusted (supply chain) | Serves `sw.js` too |

### Threats (STRIDE)

| Threat | STRIDE | Likelihood | Impact | Mitigation |
| ------ | ------ | ---------- | ------ | ---------- |
| A paired phone gives an endpoint on the LAN or any host, making the computer POST there (SSRF) | E/T | Med | Med: requests to internal services from the computer | Endpoint allowlist of push-service hosts, `https` only, default port, no userinfo, length cap; tests include look-alike hosts and IP literals |
| A paired phone sends malformed keys to crash the computer | D | Low | Low | Exact length/format checks; `ring` rejects invalid points/keys; push runs in a spawned task, errors only logged |
| Notification spam from a paired computer | D | Low | Low | Only on an offer, one per phone per 30 s, only when the page is offline; the phone owner can turn push off or Forget the computer |
| `settings.json` leaked → attacker sends notifications to the phone | S | Low | Low: fake "wants to send you files" (no file access; the phone still has to open Yon, where offers come only through the sealed session) | File is 0600 like today; turning push off on the phone unsubscribes (old key useless); same exposure class as pairing keys already in that file |
| Push service reads file names / content | I | — | — | Payload has no file names; RFC 8291 encryption to the phone's key |
| Push service / network learns when the phone gets offers and from how many computers | I | — | Low | Accepted, documented; no payload names beyond the computer name |
| Spoofed notification text tricks the user | S | Low | Low | Tapping only opens Yon; any offer shown there is authenticated by the sealed session, not by the notification |
| Malicious `sw.js` (compromised deploy) intercepts requests | E/I | Low | High | No `fetch` handler: a future `sw.js` without one can't intercept; supply-chain controls as for `link.js` (CI-only deploys, reviewers). A compromised deploy is already game over for the page |
| Service worker keeps stale code after a fix | T | Low | Med | No caching in the SW; the browser re-checks `sw.js` on navigation; `sw.js` served `Cache-Control: no-cache` |
| VAPID key reused across phones | I | — | — | Generated per phone on the phone; never leaves except to that phone's own computers |
| Replay of `/push/subscribe` | T | — | — | Existing sealed-session replay window |

### Residual risks

- Push services see timing and the computer's IP when it sends.
- Any computer the phone is paired with can make it show a Yon notification
  until push is turned off or the computer is forgotten.
- iOS behaviour for icons added before the manifest existed is unverified.

### Controls required (before shipping)

- [ ] Endpoint allowlist + tests (look-alike host, IP literal, http, port, userinfo).
- [ ] RFC 8291 test vector passes; VAPID JWT verifies.
- [ ] Push sending never blocks or fails an offer; errors logged without the endpoint.
- [ ] `sw.js` has no `fetch` handler (test that greps the built file).
- [ ] `sw.js` served with `Cache-Control: no-cache`.
- [ ] Payload contains no file names (test).
- [ ] 404/410 clears the stored subscription.
