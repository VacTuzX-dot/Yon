# Built-in relay, one-click "Reach from anywhere", and "Pair again"

**Status:** Approved (2026-09-28)
**Target release:** v0.2.2 (after the v0.2.1 updater-key transition)
**Builds on:** ADR-001 (Yon Link), ADR-003 (blind relay)

## Goal

A phone on cellular data reaches Yon on a computer on another network with
one click on the computer and no relay address to type, like Blip. Phones
paired before this change are clearly marked and can be re-paired in place
without ever losing a working pairing.

## Decisions

1. **One pairing, always through the relay.** With "Reach from anywhere" on,
   every new pairing uses the HTTPS page and the relay, at home too. The
   HTTPS page cannot call the computer's `http://` LAN address (mixed
   content), so there is no LAN shortcut. Cost: at home, speed is bounded by
   the relay host's connection. Direct P2P with relay fallback is future work.
2. **The built-in relay is set at build time**, not in source:
   `option_env!("YON_DEFAULT_RELAY")`, passed by `release.yml` from the repo
   variable `vars.YON_DEFAULT_RELAY`. No hostname is committed. The variable
   is set only after the maintainer confirms the hostname.
3. **Remote mode stays off by default.** With a built-in relay, turning it on
   is one click. The relay address field remains as an optional override.
4. **"Pair again" replaces in place.** The old pairing keeps working until
   the new pairing has proven its key; only then is the old one removed.

Unchanged: relay protocol, Yon Link crypto, phone page (`web/`), relay
service, presence events.

## Backend

### Settings (`src-tauri/src/settings.rs`)

`PairedPhone` gains two fields, both `#[serde(default)]` so older
`settings.json` files load:

| Field | Type | Meaning |
|---|---|---|
| `relay` | `String` | Relay this pairing was made for, as the normalized URL (defined below); empty = home Wi-Fi only. |
| `replaces` | `Option<String>` | Set only while pending: id of the pairing to remove once this one authenticates. |

The existing `created: u64` (Unix seconds) is set to the time `pair_phone`
creates the record and is persisted, so it doubles as the pending start
time. No new timestamp field.

### Normalized relay URL

The **normalized URL** is exactly the string `validate_relay_url` returns.
This design makes that return value canonical, so equivalent spellings of
the same relay produce the same string:

1. Trim surrounding whitespace.
2. Lowercase the whole value. It holds only a scheme, a host and an
   optional port (paths, queries and fragments are already rejected), and
   all three are case-insensitive.
3. Remove trailing `/`.
4. Drop the default port: `:443` for `wss://`, `:80` for `ws://`.

Examples, all normalizing to `wss://relay.example.com`:
`WSS://Relay.Example.com`, `wss://relay.example.com/`,
`wss://relay.example.com:443`, ` wss://relay.example.com `.

Consequences:

- **Equivalent forms never trigger "Pair again"**, because every comparison
  is between normalized strings. `Settings::load` also stores the
  normalized form of `relay_url`, so an override saved by an older version
  is normalized on the next start.
- **A different host, a non-default port or a different scheme does trigger
  "Pair again"**, on purpose. The phone's link would point at a different
  relay endpoint.
- The phone page already lowercases the relay host it parses from the link
  (`web/link.ts`), so the page and the computer agree on the form.

Test `relay_url_canonical_forms` covers every example above, plus
`wss://relay.example.com:8443` staying distinct.

Functions (pure; the save step is injected so failures are testable):

- `effective_relay(&Settings) -> Option<String>`: the `relay_url` override
  if set, else the build default if it passes `validate_relay_url`, else
  `None`. An invalid build default is ignored and logged once:
  `[yon] ignoring invalid built-in relay`.
- `phone_note(&PairedPhone, remote_on, effective: Option<&str>) -> Option<Note>`
  (exact string comparison of normalized URLs):
  - remote on and `Some(phone.relay) != effective` → `HomeOnly` ("Home Wi-Fi
    only · Pair again"). Covers phones paired before v0.2.2 (empty `relay`)
    and phones paired to a previous relay.
  - remote off and `phone.relay` not empty → `NeedsRemote` ("Needs Reach from
    anywhere").
  - otherwise none.
- `complete_replacement(&Settings, new_id, save) -> io::Result<Option<Settings>>`
- `cancel_pending(&Settings, new_id, save) -> io::Result<CancelOutcome>`
  (`Cancelled` | `Completed` | `NotFound`)
- `expire_pending(&Settings, now, save) -> io::Result<Option<Settings>>`

### Change rule for complete, cancel and expire

All three run while holding the settings lock and follow the same steps:

1. Compute the result on a **clone** of the settings.
2. If nothing changes, return without saving.
3. `save(&clone)`.
4. Only if the save succeeds, the caller swaps the clone into memory and
   calls `sync_link`.

If the save fails, memory and disk both keep the previous state: the old
pairing keeps working and the new one stays pending. The error is logged as
`[yon] couldn't save pairing change: <error>`. Completion retries on the
next authenticated session; expiry retries on its next tick.

Because all three are serialized by the lock, whichever runs first wins and
the other sees its result:

- **Cancel after completion:** `replaces` is already `None` → `Completed`,
  nothing removed. The UI shows "Paired".
- **Completion after cancel or expiry:** the new pairing no longer exists →
  `Ok(None)`. Its sessions are refused anyway: `sealed()` checks that the
  phone is still paired (`link/mod.rs:496`).
- **Duplicate authenticated events:** the second finds `replaces == None` →
  `Ok(None)`.

Cancel and expiry only ever remove records whose `replaces` is set. Neither
touches the pairing named in `replaces`.

### Completing a replacement

For `new_id` with `replaces == Some(old_id)`: remove `old_id` (no error if
it is already gone) and set the new record's `replaces` to `None`. For any
other `new_id` (unknown, or not pending): `Ok(None)`.

### Pending expiry

- `PENDING_TTL = 15 min` (900 s).
- A record is expired when `replaces.is_some()` and either
  `now.saturating_sub(created) >= 900` or `created > now + 60`. The second
  condition expires records stamped in the future, e.g. after the clock
  moved back, instead of keeping them indefinitely.
- Runs: at startup before the Link starts (covers crashes and forced
  exits); every 60 s while any pending record exists; at the start of every
  `pair_phone`.

### Authenticated signal (`src-tauri/src/link/mod.rs`)

- `Session` gains `authed: bool`.
- `Link::set_on_authenticated(Arc<dyn Fn([u8; 16]) + Send + Sync>)`.
- In `sealed()`, after `open()` succeeds and the replay window accepts the
  counter, if `!s.authed`: set it and call the callback with `s.phone_id`.
  This fires once per session, only after the pairing key K has been proven.
- It never fires from `/hello` (unauthenticated), a bad tag, a replayed
  counter, or presence.

### Commands and wiring (`src-tauri/src/app.rs`, `lib.rs`)

- `set_remote(enabled, relay_url)`: empty `relay_url` means "use the
  default". Enabling with no effective relay fails with "Add a relay address
  under Advanced to turn this on."
- `pair_phone(name, replaces: Option<String>)`: runs `expire_pending`; drops
  an earlier pending record with the same `replaces`; records
  `relay = effective_relay` (normalized URL) when remote is on (else empty); sets `replaces`
  and `created = now`. The phone limit (20) counts pending records.
- New `cancel_pairing(id)` → `cancel_pending`; registered in `lib.rs`.
- The authenticated callback → `complete_replacement` → on change, swap,
  `sync_link`, emit `settings-changed`.
- The expiry timer runs only while pending records exist.
- `PhoneDto` gains `note` and `pending`.
- In anywhere mode `PairDto.fallback` is `None` (no Wi-Fi-only code). In
  home-Wi-Fi mode the IP-address fallback stays.

## UI

### Settings → Phones (`src/components/SettingsSheet.tsx`)

- **Toggle "Reach from anywhere".** Hint names the effective relay host and
  what it can see: "Through <host>. It passes on encrypted data only; it can
  see internet addresses, when devices connect and how much they send." No
  hostname is hardcoded in the UI.
- **Relay address** moves under the existing **Advanced** section.
  Placeholder: the built-in host, or `wss://relay.example.com` if there is
  none. The hint depends on the build:
  - built-in relay exists: "Leave empty to use the built-in relay."
  - no built-in relay: "Required to turn on Reach from anywhere."

  In the no-built-in case the toggle stays disabled until an address is
  saved. Saved when the field loses focus; a `validate_relay_url` error
  shows under the field and the previous value is kept.
- **Phones list:** name plus the backend `note`. For `HomeOnly`, show a
  **Pair again** `<button>`; `NeedsRemote` is text only. Pending records are
  hidden. "Remove" is unchanged.
- The `RemoteLine` status (connecting / connected / error) is unchanged.

### Pairing sheet (`src/components/PairPhoneSheet.tsx`)

- New prop `replace?: { id, name }`: title "Pair <name> again"; name
  pre-filled and fixed; calls `pairPhone(name, replaces: id)`.
- **Done signal in replace mode:** a `settings-changed` event in which the
  new pairing is present and not pending. Presence alone does not count.
- **Steps:**
  1. Scan the code and open the link on the phone.
  2. The sheet waits.
  3. After it is confirmed, it shows "Paired. On the phone, delete the old
     Yon icon from the Home Screen, then tap Share → Add to Home Screen on
     this page."

  The old pairing keeps working until that confirmation.
- **Closing early** (Done, Esc, backdrop) while pending → `cancelPairing(newId)`.
  If the result is `Completed`, show "Paired" instead.
- Normal pairing is unchanged except that the Wi-Fi-only code is hidden in
  anywhere mode.

### API (`src/api.ts`, `src/App.tsx`)

`pairPhone(name, replaces?)`, `cancelPairing(id)`, and `Phone.note` /
`Phone.pending`. `App.tsx` listens for `settings-changed`.

## Error behaviour

| Situation | Behaviour |
|---|---|
| Enable with no effective relay | Error text; toggle stays off. |
| Invalid override | Error under the field; previous value kept. |
| Invalid build default | Treated as none; logged once. |
| Save fails (complete / cancel / expire) | Previous state kept in memory and on disk; logged; retried later. |
| Phone limit (20, pending included) | Existing "too many phones" error. |
| Sheet left open past the TTL (pending expired) | `cancelPairing` returns `NotFound`; the sheet shows "This code expired. Pair again." The old pairing is untouched. |
| Old Home Screen icon after replacement | `/hello` → 404. Check the page's message during implementation; if unclear, show "This link was replaced. Use the new Yon icon." |

## Files

| File | Change |
|---|---|
| `src-tauri/src/settings.rs` | Canonical `validate_relay_url` (normalized on load), fields, `effective_relay`, `phone_note`, `complete_replacement`, `cancel_pending`, `expire_pending`, `PENDING_TTL`, tests. |
| `src-tauri/src/link/mod.rs` | `Session.authed`, `set_on_authenticated`, hook in `sealed()`. |
| `src-tauri/src/app.rs` | Commands, wiring, expiry timer, DTOs, event, no Wi-Fi-only fallback in anywhere mode. |
| `src-tauri/src/lib.rs` | Register `cancel_pairing`. |
| `src/api.ts`, `src/App.tsx` | Types, commands, event listener. |
| `src/components/SettingsSheet.tsx` | Toggle, Advanced relay address, notes, Pair again. |
| `src/components/PairPhoneSheet.tsx` | Replace mode, confirmation, cancel, icon step. |
| `tests/link.rs` | Authenticated-signal integration test. |
| `.github/workflows/release.yml` | `YON_DEFAULT_RELAY: ${{ vars.YON_DEFAULT_RELAY }}` on the build step. |
| `docs/adr/ADR-003-yon-link-anywhere-relay.md`, `docs/threat-model-link-relay.md`, `README.md` | Build-time default relay run by the maintainer, what it sees, Pair again. |

## Tests

### Unit (`settings.rs`)

| Test | Checks |
|---|---|
| `replacement_completes_after_auth` | Old removed, new kept, `replaces` cleared, one save. |
| `no_auth_then_expiry_keeps_old` | Pending removed at TTL; old kept. |
| `unrelated_phone_auth_is_noop` | `Ok(None)`, no save. |
| `duplicate_auth_is_idempotent` | State after the 2nd call equals state after the 1st. |
| `save_failure_keeps_old` | For complete, cancel and expire, the original is unchanged. |
| `cancel_after_complete_is_noop` | `Completed`, nothing removed. |
| `cancel_never_removes_old` | The `replaces` target survives. |
| `expiry_after_ttl_keeps_old` | TTL − 1 s kept, TTL removed; old kept. |
| `expiry_survives_restart` | Save pending, reload with `now` past TTL → removed. |
| `expiry_future_timestamp` | `created > now + 60` → removed. |
| `expiry_ignores_completed` | `replaces == None` with an old `created` → kept. |
| `effective_relay_order` | Override > default > none; invalid default ignored. |
| `relay_url_canonical_forms` | Case, trailing `/`, default port and whitespace normalize to one string; a non-default port stays distinct. |
| `phone_note_cases` | HomeOnly / NeedsRemote / none. |

### Integration (`tests/link.rs`)

`authenticated_fires_only_after_valid_sealed_request` checks that the signal
does not fire for `/hello` alone, a bad tag, or a replay, and fires once for
the first valid sealed request in a session.

### Gate

`cargo fmt --check`, `cargo test`,
`cargo clippy --all-targets --all-features -- -D warnings`,
`bun test web/ relay/`, `bun run typecheck`, `bun run lint`.

## Updater-key transition gate

The old updater key (`4B3800D4DE072F1A`) was exposed and is treated as
compromised. The updater trusts exactly one public key, baked into each
build (`tauri-plugin-updater` `config.rs:116`). v0.2.1 is the transition
release: signed with the old key so v0.2.0 accepts it, and embedding the new
key (`424AB9F8F9EBF407`) so every later update must be signed with the new
key. Each check below must pass, in order, before the next step. The
rotation is complete only after G6.

| # | Check | How | Required before |
|---|---|---|---|
| G1 | The v0.2.1 `.sig` files verify cryptographically with the **old** key and fail with the new key | OpenSSL Ed25519 on the draft files: BLAKE2b-512 prehash (`ED`), the file signature and the trusted-comment signature; `latest.json` signatures equal the `.sig` files | Publishing v0.2.1 |
| G2 | Every distributed build of v0.2.1 embeds the **new** public key and not the old one | First check each file against `SHA256SUMS.txt`, then search for the exact pubkey strings (new: 1 match, old: 0) in: (a) the app binary in the macOS updater bundle `.app.tar.gz`; (b) the app binary inside the `.dmg` (`Yon.app/Contents/MacOS/yon`); (c) `yon.exe` extracted from the Windows NSIS installer. Extract without mounting or running anything, using an extractor that is already installed (7-Zip with NSIS and DMG support), or use an isolated Windows machine. No new tools without the maintainer's approval. | Publishing v0.2.1 |
| G3 | The new **private** key matches the embedded public key | The maintainer signs a test file on their own Mac with `~/.tauri/yon-updater-v2.key`, typing the password at a hidden prompt. The agent never receives the private key or the password; it verifies only the resulting `.sig`, with the new public key (G1 method) | Rotating the GitHub secret |
| G4 | v0.2.0 updates to v0.2.1 | After v0.2.1 is published: the Update button on v0.2.0 (macOS, and Windows if available) installs and relaunches v0.2.1 | Rotating the GitHub secret |
| G5 | The GitHub secrets hold the new key | Replace both secrets from the file (no printing). Then, for the v0.2.2 draft: every `.sig` must verify with the new key and fail with the old one (G1 method, keys swapped), and every distributed build must still embed the new key (G2 method) | Publishing v0.2.2 |
| G6 | v0.2.1 accepts an update signed by the new key | The Update button on v0.2.1 installs and relaunches v0.2.2 | Declaring the rotation complete |

Additional rules:

- **Installs still on v0.2.0.** The updater reads only the latest
  `latest.json`, so once v0.2.2 is published, a v0.2.0 install can no longer
  update (v0.2.2 is signed with a key v0.2.0 does not trust). Before
  publishing v0.2.2, confirm the known v0.2.0 installs have moved to v0.2.1.
  Any that have not must reinstall by hand; the v0.2.2 release notes say so.
- **The old private key** stays on the maintainer's machine until G6 passes
  (no other use is planned), then the maintainer deletes it.
- **If a gate fails**, nothing after it runs. The draft, tag and branch stay
  as they are until the maintainer decides.

## Release order

`relay.yml` is already on **local** `main` (`c9d81ed`, unpushed). The
`production` environment must be protected before any push or tag that
places it on GitHub.

| # | Step | Who |
|---|---|---|
| 0 | Create `production` with required reviewers, deployment rule tag `v*` (and branch `main` for manual runs); allow `tag:cicd` for the Tailscale OAuth client. Verified through the API before any push. | Maintainer, then verified |
| 1 | Updater-key gate G1–G3 pass → publish v0.2.1 → G4 → rotate the signing secrets (G5). | Maintainer approves and tests |
| 2 | Merge `release/v0.2.1` into local `main`, taking its version and pubkey. Not pushed. | Agent |
| 3 | Implement this spec on a branch off `main`; full gate locally. | Agent |
| 4 | Maintainer confirms the relay hostname → set `vars.YON_DEFAULT_RELAY`. | Maintainer |
| 5 | Push `main` → bump to 0.2.2 → tag. Verify: `.sig` verifies with the new key `424AB9F8F9EBF407` (G5); built-in relay present in the binary; Relay deploy waits for approval; Pages. Confirm v0.2.0 installs have moved on before publishing. | Maintainer approves each push, tag, publish |
| 6 | Publish v0.2.2 → G6 (v0.2.1 updates to v0.2.2). | Maintainer approves and tests |
| 7 | Acceptance: iPhone on cellular with the computer on another Wi-Fi; Pair again (success, cancel, expiry); relay restart and reconnect; failed deploy rolls back. | Maintainer and agent |

## Out of scope

Direct P2P / WebRTC, multiple relays, fetching relay config at runtime,
changes to the relay protocol or Yon Link crypto, raising the relay's
per-IP limit (to revisit if mobile CGNAT causes 429s).
