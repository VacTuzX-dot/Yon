## Threat Model: phone keyring backup with a passkey (ADR-005, proposed)

Scope: the phone page backing up its list of computers to the default relay,
encrypted with a key from a passkey's PRF output, and restoring it after the
Home Screen app's storage is gone. Builds on the relay model
(threat-model-link-relay.md) and the many-computers model
(threat-model-phone-computers.md). Decision: [ADR-005](adr/ADR-005-phone-keyring-passkey-backup.md).

### Assets

- Pairing strings for up to 4 computers (`<pair id>.<K>.<room>@<relay>`): whoever holds one can offer files to that computer and receive what it sends to this phone
- The PRF output `S` and the keys derived from it: `T` (record token) and `E` (record key)
- The passkey itself, in iCloud Keychain or Google Password Manager
- The encrypted backup record on the relay

### Trust Boundaries

- Phone page ↔ platform authenticator (WebAuthn, user verification on the device)
- Platform authenticator ↔ the user's cloud account (passkey sync, end-to-end encrypted by the platform)
- Phone page → relay `/backup` over HTTPS through Cloudflare
- Relay process → its record store on disk

### Actors

| Actor | Trust | Notes |
| ----- | ----- | ----- |
| The phone's owner | Trusted | Turns backup on, confirms each write and the restore with Face ID / fingerprint / PIN |
| The owner's other devices with the same passkey | Trusted | Can restore the same computers (by design) |
| Someone who takes over the owner's iCloud / Google account | Untrusted | Gets the passkey only on a device they can unlock with the account's device passcode |
| Relay operator or anyone who controls the relay host | Untrusted for content | Sees `SHA-256(T)`, `T` on each request, ciphertext, IP, timing |
| Cloudflare (TLS terminates there) | Untrusted for content | Sees what the relay sees |
| Anyone on the internet | Untrusted | Can call `/backup` with any token |
| Whoever controls the page deploy (yon.meo.in.th) and CI | Trusted (supply chain) | Page code can ask the authenticator for `S` |

### Attack Surface

- `GET /backup`, `PUT /backup`, `DELETE /backup` on the relay (new, unauthenticated except for `T`)
- The relay's record store (new state)
- `navigator.credentials.create/get` with the PRF extension on the phone page
- The spike page `/phonelink/prf-spike/` while it exists (WebAuthn only, no network)

### Threats (STRIDE)

| Threat | STRIDE | Likelihood | Impact | Mitigation |
| ------ | ------ | ---------- | ------ | ---------- |
| Relay or Cloudflare reads the keyring | I | Low | High | Record is XChaCha20-Poly1305 under `E`; `E` never leaves the phone. The relay only ever sees `T`, from which `E` can't be derived (independent HKDF labels) |
| Relay swaps in a record it made | S/T | Low | High | Without `E` it can't produce a record that opens; AAD binds the record to `SHA-256(T)`, so a record from another user's token fails too |
| Relay serves an older record (rollback) | T | Low | Low | The user gets back a computer they forgot; that computer still has to accept the pairing; Forget again. Accepted (residual) |
| Relay deletes or loses records | D | Low | Low | Restore fails; the user pairs again as today. No data beyond pairings is lost |
| Internet attacker guesses a token | S | Very low | High | `T` is 256 bits from HKDF; the relay stores only `SHA-256(T)`; per-IP rate limits on every method |
| Internet attacker fills the store | D | Medium | Medium | Fixed record size (4 KiB + nonce + tag); global record cap with 507; per-IP limits with 429 + `Retry-After`; records idle 400 days are dropped |
| Attacker overwrites a user's record | T | Very low | Medium | Writing needs `T`; `If-Match` on the version stops lost updates between the owner's own devices |
| Record size reveals the number of computers | I | Medium | Low | Plaintext padded to a fixed 4 KiB |
| Relay links one person across time and devices | I | High | Low | Same token from every device and restore. The relay already sees IPs and rooms. Documented in the privacy note |
| Account takeover (iCloud / Google) restores every computer | E | Low | High | Needs the account plus a device the attacker can unlock; backup is opt-in and the setting says what it trusts. Computers can still remove the phone |
| XSS on yon.meo.in.th asks the authenticator for `S` | E | Low | High | Every PRF call needs user verification, so the user sees a Face ID prompt they did not start. Same origin already holds every key in `localStorage`; existing controls (`script-src 'self'`, SRI on `link.js`, CI-only deploys) apply unchanged |
| Malicious page on another origin asks for `S` | S | Low | High | WebAuthn binds the passkey to `rp.id = yon.meo.in.th`; another origin can't use it |
| Spike passkey later picked by the real restore | T | Medium | Low | Spike uses its own user name ("Yon PRF test — delete me") and its own salt, so its PRF output never decrypts a real record. The spike page says to delete the passkey; the page is removed before backup ships |
| Relay logs `T` | I | Low | Medium | `T` alone opens nothing; the relay logs no request headers. Rotation: turning backup off and on again creates a new passkey and token |

### Residual Risks

- The backup's safety rests on the user's cloud account and device passcode. Accepted: opt-in, and the same trust users already give saved passwords.
- Rollback by the relay restores a forgotten computer. Accepted: low impact, visible in the list.
- The relay keeps state (one opaque record per user who turns backup on). Losing it only means pairing again.
- Two devices restored from one passkey share each pairing; Web Push reaches only the last one to subscribe (ADR-005).

### Controls Required (before shipping)

- [ ] Device spike answers ADR-005's open questions (PRF stable in the iOS Home Screen app across delete and re-add; Android GPM)
- [ ] `T` and `E` from separate HKDF labels; test vectors committed
- [ ] Record padded to a fixed size; AAD = `"yon-backup" || SHA-256(T)`; open failure shows one generic error
- [ ] Relay stores `SHA-256(T)` only; constant-size records; global cap; per-IP limits with 429 + `Retry-After`; no header logging
- [ ] `If-Match` / `If-None-Match` on writes; tests for 412
- [ ] `userVerification: "required"` on every create and get
- [ ] Phone CSP `connect-src` adds only the default relay's exact `https://` origin
- [ ] Restore only on a user tap, never on page load
- [ ] Spike page and its build step removed before backup ships
