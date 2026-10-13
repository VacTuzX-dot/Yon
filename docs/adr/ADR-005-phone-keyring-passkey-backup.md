# ADR-005: Restore the phone's computers with a passkey

**Status:** Proposed
**Date:** 2026-10-13

## Context

The phone page keeps every pairing (`<pair id>.<K>.<room>@<relay>`) only in
`localStorage` (`web/keyring.ts`). On iOS each Home Screen web app has its own
storage, and deleting the icon deletes it. The user then has to walk to every
computer and scan its code again. The maintainer reports this as the main pain
on mobile and asked for something closer to Blip.

How Blip does it (static look at Blip.app 1.2.3, 2026-10-13; strings and symbols
only, nothing run):

- An account per email, signed in with a one-time code (`email`, `code`,
  `code_expiry`, `token` fields). The server keeps the user's device list
  (`devices`, `device_id`, `device_dedupe_id`).
- Each connection makes a fresh TLS certificate and pins the peer's fingerprint
  (`brokeredmtls.GenerateCertFingerprintAndKey`, `allowOnlyThisFingerprint`).
  The fingerprints appear to be handed out by Blip's server (inferred from the
  package name), so the server is the root of trust: whoever controls it, or
  the user's email, can add a device and read what is sent.

Yon's root of trust is the QR code scanned in person, and the relay is blind
(ADR-003). That must not change. What we need is narrower: get back the
pairings this phone already had, after its storage is gone, without trusting
the relay with any key.

Constraints:

- The relay (`relay/relay.ts`) keeps no state today: one computer per room,
  no storage. A phone with empty storage does not know any room to ask.
- The computer side and the pairing protocol should not change. A restored
  pairing is the same `P.K.R` string, so computers see the same phone.
- Secure > fast > lite. No new runtime dependency on the page.

WebAuthn gives the page a secret that lives outside its storage:

- The **PRF extension** returns 32 bytes derived from the passkey and a salt
  we choose. The passkey syncs through iCloud Keychain or Google Password
  Manager, so the same secret comes back after the icon is deleted, and on the
  user's other devices. Getting it needs Face ID / fingerprint / device PIN.
- The **largeBlob extension** stores bytes inside the passkey itself.

## Decision

We will back up the keyring, encrypted with a key from a passkey's PRF output,
as one small opaque record on the default relay.

1. **Passkey.** "Back up computers" in the Computers sheet creates a
   discoverable passkey: `rp.id = yon.meo.in.th`, `user.id` = 16 random bytes,
   `residentKey: "required"`, `userVerification: "required"`. The page then
   asks for PRF with the fixed salt `SHA-256("yon-keyring-v1")` and gets `S`
   (32 bytes). `S` is never stored; it lives in memory for one operation.
2. **Keys.** `HKDF-SHA256(S, info)` with two labels:
   - `T = HKDF(S, "yon-backup-token")`: names and authorizes the record.
   - `E = HKDF(S, "yon-backup-key")`: XChaCha20-Poly1305 key for the record
     (`@noble/ciphers`, already used by Yon Link).
3. **Record.** Plaintext: `{v: 1, ver: <counter>, computers: [raw...],
   forgotten: [id...], auto: [id...]}`, padded to a fixed 4 KiB so the size
   gives nothing away. Sealed with `E`, random 24-byte nonce, AAD
   `"yon-backup" || SHA-256(T)`.
4. **Relay endpoint** (on the default relay host, baked into the page at
   build time like `YON_DEFAULT_RELAY` for the app):
   - `GET /backup` with `Authorization: Yon <T hex>`: 200 with the record, or 404.
   - `PUT /backup` with the same header, body = record, header `If-Match: <ver>`
     (or `If-None-Match: *` for the first write): 204, or 412 on a version
     mismatch.
   - The relay stores `SHA-256(T) → (record, ver, last_seen)` in `bun:sqlite`
     on a volume. It never sees `S` or `E`. A record nobody reads or writes
     for 400 days is dropped.
   - Limits: body exactly 4 KiB + nonce/tag; per-IP rate limit on both
     methods (429 with `Retry-After`); global record cap (507 when full).
5. **When the page writes.** After every keyring change (add, forget,
   auto-receive) if backup is on. On a 412 it fetches, merges (union of
   computers minus forgotten, newest `raw` per id), and retries once.
   Writing needs `S`, so each change asks for Face ID once.
6. **Restore.** An empty keyring shows "Restore computers". It calls
   `navigator.credentials.get` with no `allowCredentials` (any Yon passkey on
   the device), PRF salt as above, then `GET /backup`, opens the record, and
   writes the computers through `addComputer`. Nothing is restored silently on
   page load.
7. **Off switch.** "Turn off backup" sends `DELETE /backup` with `T`. The
   passkey stays in the user's password manager; the page says so and how to
   remove it there.
8. **Fallback.** No PRF support: the backup option is hidden and pairing works
   as today. Computers keep "Pair again".
9. **CSP.** The phone page's `connect-src` adds `https://<default relay host>`.

ADR-003's "the relay keeps nothing" becomes "the relay keeps nothing it can
read": one opaque record per user who turns backup on.

## Consequences

### Positive

- Deleting the Home Screen icon no longer loses computers: add the icon,
  tap Restore, Face ID, done. Works even when the computers are offline.
- The same passkey on an iPad or a new phone restores the same computers,
  which is most of what Blip's sign-in gives.
- Computers, the pairing protocol and the QR trust model are unchanged.
  Rust code is not touched.
- The relay holds ciphertext and a hash of a token; reading it needs the
  passkey, which needs the user's biometrics and their password manager.
- No new dependency: WebAuthn is a browser API; HKDF, SHA-256 and AEAD are
  already in `@noble/*`; storage is `bun:sqlite`.

### Negative / Trade-offs

- 🟠 The keyring's safety now also rests on the user's iCloud / Google
  account. Anyone who takes over that account and a device unlock can
  restore every computer. Same trust users already give their saved
  passwords; the backup is opt-in and says so.
- The relay is no longer stateless: a volume, backups of it are not needed
  (losing it only means "pair again"), but it must not be world-readable.
- The relay learns that one token belongs to one IP over time, and can link
  restores to the rooms the phone then joins. It sees rooms and IPs already.
- Rollback: the relay can serve an older record and bring back a computer the
  user forgot. The computer must still accept that pairing, and the user can
  forget it again. Accepted.
- Two devices restored from one passkey share each pairing. Computers see
  them as one phone: the Web Push subscription is per pair id, so the last
  device to subscribe gets the notifications. Fixing that needs a per-device
  id in the protocol; out of scope here.
- One more Face ID prompt per keyring change while backup is on. Creating the
  backup may need two (some browsers return PRF only on `get`, not `create`).
- Self-hosters with their own relay get backup only if their page build
  points at it.

## Alternatives Considered

| Option | Why rejected |
| ------ | ------------ |
| Blip-style account (email + one-time code, server device list) | Makes the relay the root of trust: whoever controls it or the user's mailbox can add a device. Accounts and a user database |
| PRF identity instead of per-pairing keys (computers pair with the passkey) | Changes the pairing protocol on both sides and still needs a directory to find rooms; more code for the same restore |
| Computers hold the backup, found through rooms derived from `S` | Relay allows one computer per room, so it needs per-slot rooms, a second relay socket per computer and Rust changes; restore fails for computers that are offline |
| Keyring in the passkey (`largeBlob`), no server | Google Password Manager on Android does not support it, and writing it on iOS needs a fresh assertion per change; revisit if support grows |
| Backup link / QR with all keys, saved by the user | Plain keys in Notes or Photos; anyone who sees it reaches every computer |
| "Show code again" on each computer | Still one walk to each computer; kept as the fallback that already exists (Pair again) |

## Open questions (verify on devices before Accepted)

1. PRF returns a stable value in an iOS Home Screen app (standalone) on
   iOS 18+, and after the icon is deleted and added again.
2. PRF with Google Password Manager passkeys in Chrome on Android.
3. Whether `create()` returns PRF results on each platform (one or two prompts).
4. iOS keeps the passkey's `rp.id` usable from the standalone app without
   opening Safari.

## Implementation steps (one commit each, after approval)

1. Threat model `docs/threat-model-phone-backup.md` (new endpoint, new stored
   data).
2. Spike page on yon.meo.in.th: create passkey, read PRF twice, delete the
   icon, read again. Answers the open questions; no backup yet.
3. Relay: `/backup` GET/PUT/DELETE, `bun:sqlite`, limits, tests.
4. Page: `web/backup.ts` (derive, seal, open, merge) with tests against fixed
   vectors; Computers sheet buttons; restore on empty keyring.
5. Website: `connect-src` and the baked relay host; deploy relay volume.
