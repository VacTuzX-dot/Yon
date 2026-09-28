# Built-in relay and "Pair again" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click turns on "Reach from anywhere" using a relay baked in at build time, and phones paired before are re-paired in place without ever losing a working pairing.

**Architecture:** Pure settings functions (`settings.rs`) own every state change (normalize, effective relay, notes, complete/cancel/expire a pending replacement) and take the save step as a closure so failures are testable. `link/mod.rs` reports "this session proved the pairing key" once per session; `app.rs` wires that signal, the commands and a 60 s expiry timer. The React UI reads `note`/`pending` from the backend and never decides pairing state itself.

**Tech Stack:** Rust (Tauri v2, tokio, serde), React + TypeScript, Bun.

Spec: `docs/superpowers/specs/2026-09-28-anywhere-default-relay-design.md`

## Global Constraints

- Build default: `option_env!("YON_DEFAULT_RELAY")`, set by `release.yml` from `vars.YON_DEFAULT_RELAY`. **No relay hostname is committed** anywhere (source, UI, tests use `relay.example.com`).
- Remote mode stays **off by default**.
- Normalized relay URL = exactly what `validate_relay_url` returns: trim, lowercase, strip trailing `/`, drop `:443` (`wss://`) / `:80` (`ws://`).
- `PENDING_TTL = 900` s; expired when `replaces.is_some()` and (`now.saturating_sub(created) >= 900` or `created > now + 60`).
- complete / cancel / expire: compute on a clone → no change = no save → `save(&clone)` → caller swaps only if save succeeded. Log: `[yon] couldn't save pairing change: <error>`.
- Cancel and expiry only remove records whose `replaces` is set; never the record named in `replaces`.
- Phone limit 20 counts pending records.
- Error strings (exact): `Add a relay address under Advanced to turn this on.`, `[yon] ignoring invalid built-in relay`, `This code expired. Pair again.`
- Unchanged: relay protocol, Yon Link crypto, `web/` phone page, `relay/`, presence events.
- Gate (all must pass before each commit that touches the language): `cargo fmt --check`, `cargo test`, `cargo clippy --all-targets --all-features -- -D warnings` (in `src-tauri/`); `bun test web/ relay/`, `bun run typecheck`, `bun run lint` (repo root).
- Work on branch `feat/default-relay` off `main`. Never push.

## Additions beyond the spec (flagged for review)

1. **Trust follows the replacement.** If the old phone was in "Accept automatically from", `complete_replacement` moves that entry to the new phone's fingerprint. Otherwise Pair again would silently drop "Always accept" and leave an orphan entry in the list.
2. **Pending phones are not send targets.** `allDevices()` in `api.ts` skips `pending` phones.
3. **`SettingsDto` gains `default_relay` and `effective_relay`** (normalized URLs or `null`) so the UI can name the host without hardcoding it.
4. **The page's 404 text stays** ("This phone isn't paired with the computer anymore. Pair it again from Yon's settings."). The page cannot tell "replaced" from "removed"; the desktop sheet already tells the user to delete the old icon. `web/` stays unchanged, as the spec requires.

## File map

| File | Responsibility in this plan |
|---|---|
| `src-tauri/src/settings.rs` | Canonical URL, new fields, pure pairing-state functions, tests |
| `src-tauri/src/link/mod.rs` | `Session.authed`, `set_on_authenticated`, hook in `sealed()` |
| `src-tauri/tests/link.rs` | Authenticated-signal integration test |
| `src-tauri/src/app.rs` | Commands, DTOs, auth wiring, expiry timer, `settings-changed` |
| `src-tauri/src/lib.rs` | Register `cancel_pairing` |
| `.github/workflows/release.yml` | Pass `YON_DEFAULT_RELAY` to the build |
| `src/api.ts`, `src/App.tsx` | Types, commands, event |
| `src/components/SettingsSheet.tsx` | Toggle, Advanced relay field, notes, Pair again |
| `src/components/PairPhoneSheet.tsx` | Replace mode, confirmation, cancel, expiry |
| `docs/adr/ADR-003-…`, `docs/threat-model-link-relay.md`, `README.md` | Built-in relay, what it sees, Pair again |

---

### Task 0: Branch

- [ ] **Step 1:** `git switch -c feat/default-relay main` (from repo root). Expected: `Switched to a new branch 'feat/default-relay'`.

---

### Task 1: Canonical relay URL

**Files:**
- Modify: `src-tauri/src/settings.rs:119-121` (load), `:190-221` (`validate_relay_url`), tests module

**Interfaces:**
- Produces: `validate_relay_url(raw: &str) -> Result<String, &'static str>` now returns the normalized URL (signature unchanged).

- [ ] **Step 1: Write the failing test** (add to `mod tests` in `settings.rs`)

```rust
    #[test]
    fn relay_url_canonical_forms() {
        for raw in [
            "WSS://Relay.Example.com",
            "wss://relay.example.com/",
            "wss://relay.example.com:443",
            " wss://relay.example.com ",
        ] {
            assert_eq!(validate_relay_url(raw), Ok("wss://relay.example.com".into()), "{raw}");
        }
        assert_eq!(
            validate_relay_url("wss://relay.example.com:8443"),
            Ok("wss://relay.example.com:8443".into())
        );
        assert_eq!(validate_relay_url("WS://LOCALHOST:80"), Ok("ws://localhost".into()));
        assert_eq!(
            validate_relay_url("ws://localhost:8787"),
            Ok("ws://localhost:8787".into())
        );
        // A default port only drops for its own scheme.
        assert_eq!(
            validate_relay_url("wss://relay.example.com:80"),
            Ok("wss://relay.example.com:80".into())
        );
    }

    #[test]
    fn load_normalizes_relay_url() {
        let dir = temp_dir("settings-relay");
        let dl = Path::new("/d");
        let mut s = Settings::defaults(dl);
        s.relay_url = "WSS://Relay.Example.com:443/".into();
        s.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir, dl).relay_url, "wss://relay.example.com");
        fs::remove_dir_all(dir).unwrap();
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --lib settings::tests::relay_url_canonical_forms settings::tests::load_normalizes_relay_url`
Expected: FAIL (`WSS://…` is rejected as not starting with `wss://`).

- [ ] **Step 3: Implement.** Replace `validate_relay_url` with:

```rust
/// `wss://host[:port]`, or `ws://` for a relay on this machine (testing).
/// Empty means "not set". Returns the normalized form (lowercase, no
/// trailing `/`, no default port) so equal relays compare equal.
pub fn validate_relay_url(raw: &str) -> Result<String, &'static str> {
    let lower = raw.trim().to_ascii_lowercase();
    let url = lower.trim_end_matches('/');
    if url.is_empty() {
        return Ok(String::new());
    }
    let (scheme, rest, default_port) = if let Some(r) = url.strip_prefix("wss://") {
        ("wss://", r, 443)
    } else if let Some(r) = url.strip_prefix("ws://") {
        let host = r.split([':', '/']).next().unwrap_or("");
        if !matches!(host, "localhost" | "127.0.0.1") {
            return Err("Use a wss:// address (ws:// only for a relay on this computer)");
        }
        ("ws://", r, 80)
    } else {
        return Err("The relay address starts with wss://");
    };
    // WHY: bare host[:port] only — the phone page (web/link.ts) and the
    // desktop client both assume it; a path would pass here and fail there.
    let (host, port) = rest
        .split_once(':')
        .map_or((rest, None), |(h, p)| (h, Some(p)));
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port = match port.map(str::parse::<u16>) {
        None => None,
        Some(Ok(p)) => Some(p),
        Some(Err(_)) => return Err("That isn't a valid relay address"),
    };
    if !host_ok || url.len() > 200 {
        return Err("That isn't a valid relay address");
    }
    Ok(match port {
        Some(p) if p != default_port => format!("{scheme}{host}:{p}"),
        _ => format!("{scheme}{host}"),
    })
}
```

In `Settings::load`, replace the `relay_url` block (`:119-121`) with:

```rust
                // Stored normalized, so an override saved by an older
                // version compares equal to the same relay spelled now.
                s.relay_url = validate_relay_url(&s.relay_url).unwrap_or_default();
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --lib settings`
Expected: all `settings::tests` PASS (the existing `relay_urls_must_be_wss_or_local` still passes).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): normalize relay URLs to one canonical form"
```

---

### Task 2: Pending replacement state (complete, cancel, expire)

**Files:**
- Modify: `src-tauri/src/settings.rs` (`PairedPhone`, new functions, tests, `roundtrip_and_defaults` literal)

**Interfaces:**
- Consumes: `crate::link::phone_fingerprint(&[u8; 16]) -> Fingerprint`, `crate::protocol::{hex, unhex}`.
- Produces:
  - `PairedPhone { id, key, name, created, #[serde(default)] relay: String, #[serde(default)] replaces: Option<String> }`
  - `pub const PENDING_TTL: u64 = 900;`
  - `pub fn is_pending_expired(p: &PairedPhone, now: u64) -> bool`
  - `pub fn complete_replacement(s: &Settings, new_id: &str, save: impl FnOnce(&Settings) -> io::Result<()>) -> io::Result<Option<Settings>>`
  - `pub enum CancelOutcome { Cancelled(Settings), Completed, NotFound }`
  - `pub fn cancel_pending(s: &Settings, new_id: &str, save: impl FnOnce(&Settings) -> io::Result<()>) -> io::Result<CancelOutcome>`
  - `pub fn expire_pending(s: &Settings, now: u64, save: impl FnOnce(&Settings) -> io::Result<()>) -> io::Result<Option<Settings>>`
  - `impl Settings { pub fn has_pending(&self) -> bool }`

- [ ] **Step 1: Add the fields** (tests need them to compile). In `PairedPhone` after `created`:

```rust
    /// Relay this pairing was made for (normalized URL); empty = home
    /// Wi-Fi only. Missing in files from before v0.2.2 → empty.
    #[serde(default)]
    pub relay: String,
    /// Set only while this pairing is pending: id of the pairing it
    /// replaces once it has proven its key.
    #[serde(default)]
    pub replaces: Option<String>,
```

Update every `PairedPhone { … }` literal in the file (in `roundtrip_and_defaults` and `invalid_phones_are_dropped_on_load`) by adding `relay: String::new(), replaces: None,`. In `roundtrip_and_defaults` use `relay: "wss://relay.example.com".into()` instead so the field round-trips. In `app.rs:945` (`pair_phone`) add `relay: String::new(), replaces: None,` for now (Task 4 replaces this code).

In `Settings::load`, inside the phones block after `s.phones.truncate(MAX_PHONES);` add:

```rust
                for p in &mut s.phones {
                    p.relay = validate_relay_url(&p.relay).unwrap_or_default();
                }
```

- [ ] **Step 2: Write the failing tests** (add to `mod tests`)

```rust
    fn phone(id: u8, replaces: Option<u8>, created: u64) -> PairedPhone {
        PairedPhone {
            id: hex(&[id; 16]),
            key: hex(&[id; 32]),
            name: format!("p{id}"),
            created,
            relay: String::new(),
            replaces: replaces.map(|r| hex(&[r; 16])),
        }
    }

    fn with_phones(phones: Vec<PairedPhone>) -> Settings {
        let mut s = Settings::defaults(Path::new("/d"));
        s.phones = phones;
        s
    }

    fn id(n: u8) -> String {
        hex(&[n; 16])
    }

    /// Counts saves; `fail` makes every save return an error.
    fn saver(count: &std::cell::Cell<u32>, fail: bool) -> impl FnOnce(&Settings) -> io::Result<()> + '_ {
        move |_| {
            count.set(count.get() + 1);
            if fail {
                Err(io::Error::other("disk full"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn replacement_completes_after_auth() {
        let mut s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let old_fp = crate::link::phone_fingerprint(&[1; 16]);
        s.trust(&old_fp, "p1");
        let saves = std::cell::Cell::new(0);
        let next = complete_replacement(&s, &id(2), saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(2, None, 20)]);
        assert_eq!(saves.get(), 1);
        // "Always accept" moves to the new pairing.
        assert!(!next.is_trusted(&old_fp));
        assert!(next.is_trusted(&crate::link::phone_fingerprint(&[2; 16])));
    }

    #[test]
    fn unrelated_phone_auth_is_noop() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let saves = std::cell::Cell::new(0);
        assert_eq!(complete_replacement(&s, &id(1), saver(&saves, false)).unwrap(), None);
        assert_eq!(complete_replacement(&s, &id(9), saver(&saves, false)).unwrap(), None);
        assert_eq!(saves.get(), 0);
    }

    #[test]
    fn duplicate_auth_is_idempotent() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let saves = std::cell::Cell::new(0);
        let first = complete_replacement(&s, &id(2), saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(complete_replacement(&first, &id(2), saver(&saves, false)).unwrap(), None);
        assert_eq!(saves.get(), 1);
    }

    #[test]
    fn save_failure_keeps_old() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let before = s.clone();
        let saves = std::cell::Cell::new(0);
        assert!(complete_replacement(&s, &id(2), saver(&saves, true)).is_err());
        assert!(cancel_pending(&s, &id(2), saver(&saves, true)).is_err());
        assert!(expire_pending(&s, 20 + PENDING_TTL, saver(&saves, true)).is_err());
        assert_eq!(s, before);
        assert_eq!(saves.get(), 3);
    }

    #[test]
    fn cancel_after_complete_is_noop() {
        let s = with_phones(vec![phone(2, None, 20)]);
        let saves = std::cell::Cell::new(0);
        assert!(matches!(
            cancel_pending(&s, &id(2), saver(&saves, false)).unwrap(),
            CancelOutcome::Completed
        ));
        assert!(matches!(
            cancel_pending(&s, &id(9), saver(&saves, false)).unwrap(),
            CancelOutcome::NotFound
        ));
        assert_eq!(saves.get(), 0);
    }

    #[test]
    fn cancel_never_removes_old() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let saves = std::cell::Cell::new(0);
        let CancelOutcome::Cancelled(next) = cancel_pending(&s, &id(2), saver(&saves, false)).unwrap()
        else {
            panic!("expected Cancelled");
        };
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
        assert_eq!(saves.get(), 1);
    }

    #[test]
    fn no_auth_then_expiry_keeps_old() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 100)]);
        let saves = std::cell::Cell::new(0);
        let next = expire_pending(&s, 100 + PENDING_TTL, saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
    }

    #[test]
    fn expiry_after_ttl_keeps_old() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 100)]);
        let saves = std::cell::Cell::new(0);
        assert_eq!(expire_pending(&s, 100 + PENDING_TTL - 1, saver(&saves, false)).unwrap(), None);
        assert_eq!(saves.get(), 0);
        let next = expire_pending(&s, 100 + PENDING_TTL, saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
    }

    #[test]
    fn expiry_survives_restart() {
        let dir = temp_dir("settings-pending");
        let dl = Path::new("/d");
        let mut s = Settings::defaults(dl);
        s.phones = vec![phone(1, None, 10), phone(2, Some(1), 100)];
        s.save(&dir).unwrap();
        let loaded = Settings::load(&dir, dl);
        assert!(loaded.has_pending());
        let next = expire_pending(&loaded, 100 + PENDING_TTL + 5, |n| n.save(&dir))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
        assert!(!Settings::load(&dir, dl).has_pending());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expiry_future_timestamp() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 1_000)]);
        let saves = std::cell::Cell::new(0);
        assert_eq!(expire_pending(&s, 1_000 - 60, saver(&saves, false)).unwrap(), None);
        let next = expire_pending(&s, 1_000 - 61, saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
    }

    #[test]
    fn expiry_ignores_completed() {
        let s = with_phones(vec![phone(1, None, 0)]);
        let saves = std::cell::Cell::new(0);
        assert_eq!(expire_pending(&s, 1_000_000, saver(&saves, false)).unwrap(), None);
        assert_eq!(saves.get(), 0);
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test --lib settings`
Expected: compile error `cannot find function complete_replacement` (and the others).

- [ ] **Step 4: Implement** (after `validate_port`, before `#[cfg(test)]`):

```rust
/// A pending pairing that never proved its key is dropped after this.
pub const PENDING_TTL: u64 = 15 * 60;

/// Pending and either too old, or stamped more than a minute in the
/// future (the clock moved back) — never kept indefinitely.
pub fn is_pending_expired(p: &PairedPhone, now: u64) -> bool {
    p.replaces.is_some() && (now.saturating_sub(p.created) >= PENDING_TTL || p.created > now + 60)
}

impl Settings {
    pub fn has_pending(&self) -> bool {
        self.phones.iter().any(|p| p.replaces.is_some())
    }
}

// WHY (complete / cancel / expire): the caller holds the settings lock,
// these work on a clone, and the caller swaps the clone in only after
// `save` succeeded — a failed save leaves memory and disk as they were,
// so the old pairing keeps working.

/// `new_id` proved its key: remove the pairing it replaces (fine if already
/// gone), carry "Always accept" over, and clear `replaces`.
/// `Ok(None)` = nothing to do (unknown, or not pending).
pub fn complete_replacement(
    s: &Settings,
    new_id: &str,
    save: impl FnOnce(&Settings) -> io::Result<()>,
) -> io::Result<Option<Settings>> {
    let Some(old_id) = s
        .phones
        .iter()
        .find(|p| p.id == new_id)
        .and_then(|p| p.replaces.clone())
    else {
        return Ok(None);
    };
    let mut next = s.clone();
    next.phones.retain(|p| p.id != old_id);
    let mut new_name = String::new();
    if let Some(p) = next.phones.iter_mut().find(|p| p.id == new_id) {
        p.replaces = None;
        new_name = p.name.clone();
    }
    if let (Some(old), Some(new)) = (
        crate::protocol::unhex::<16>(&old_id),
        crate::protocol::unhex::<16>(new_id),
    ) {
        let old_fp = crate::link::phone_fingerprint(&old);
        if next.is_trusted(&old_fp) {
            next.untrust(&hex(&old_fp));
            next.trust(&crate::link::phone_fingerprint(&new), &new_name);
        }
    }
    save(&next)?;
    Ok(Some(next))
}

pub enum CancelOutcome {
    /// The pending pairing was removed; here are the saved settings.
    Cancelled(Settings),
    /// It had already proven its key: nothing removed.
    Completed,
    /// No such pairing (expired, or cancelled before).
    NotFound,
}

/// The user closed the sheet before the phone connected. Only a pending
/// record is ever removed; the pairing it would replace is untouched.
pub fn cancel_pending(
    s: &Settings,
    new_id: &str,
    save: impl FnOnce(&Settings) -> io::Result<()>,
) -> io::Result<CancelOutcome> {
    match s.phones.iter().find(|p| p.id == new_id) {
        None => Ok(CancelOutcome::NotFound),
        Some(p) if p.replaces.is_none() => Ok(CancelOutcome::Completed),
        Some(_) => {
            let mut next = s.clone();
            next.phones.retain(|p| p.id != new_id);
            save(&next)?;
            Ok(CancelOutcome::Cancelled(next))
        }
    }
}

/// Drop pending pairings past `PENDING_TTL`. `Ok(None)` = none expired.
pub fn expire_pending(
    s: &Settings,
    now: u64,
    save: impl FnOnce(&Settings) -> io::Result<()>,
) -> io::Result<Option<Settings>> {
    if !s.phones.iter().any(|p| is_pending_expired(p, now)) {
        return Ok(None);
    }
    let mut next = s.clone();
    next.phones.retain(|p| !is_pending_expired(p, now));
    save(&next)?;
    Ok(Some(next))
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd src-tauri && cargo test --lib settings && cargo clippy --all-targets --all-features -- -D warnings`
Expected: all PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/app.rs
git commit -m "feat(settings): pending phone replacement with complete, cancel and expiry"
```

---

### Task 3: Effective relay and phone notes

**Files:**
- Modify: `src-tauri/src/settings.rs`

**Interfaces:**
- Produces:
  - `pub fn default_relay() -> Option<String>` (valid build default, normalized)
  - `pub fn effective_relay(s: &Settings) -> Option<String>`
  - `#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case")] pub enum Note { HomeOnly, NeedsRemote }`
  - `pub fn phone_note(p: &PairedPhone, remote_on: bool, effective: Option<&str>) -> Option<Note>`

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn effective_relay_order() {
        let mut s = Settings::defaults(Path::new("/d"));
        let default = Some("wss://built-in.example.com".to_string());
        assert_eq!(effective_relay_with(&s, default.clone()), default);
        assert_eq!(effective_relay_with(&s, None), None);
        s.relay_url = "wss://mine.example.com".into();
        assert_eq!(
            effective_relay_with(&s, default),
            Some("wss://mine.example.com".into())
        );
        assert_eq!(default_relay_from(None), None);
        assert_eq!(default_relay_from(Some("")), None);
        assert_eq!(default_relay_from(Some("http://nope")), None);
        assert_eq!(
            default_relay_from(Some("WSS://Built-In.Example.com:443")),
            Some("wss://built-in.example.com".into())
        );
    }

    #[test]
    fn phone_note_cases() {
        let relay = "wss://relay.example.com";
        let mut p = phone(1, None, 0);
        // Paired before v0.2.2 (no relay) while remote is on.
        assert_eq!(phone_note(&p, true, Some(relay)), Some(Note::HomeOnly));
        assert_eq!(phone_note(&p, false, Some(relay)), None);
        p.relay = relay.into();
        assert_eq!(phone_note(&p, true, Some(relay)), None);
        // Paired to a previous relay.
        assert_eq!(
            phone_note(&p, true, Some("wss://other.example.com")),
            Some(Note::HomeOnly)
        );
        assert_eq!(phone_note(&p, true, None), Some(Note::HomeOnly));
        assert_eq!(phone_note(&p, false, Some(relay)), Some(Note::NeedsRemote));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --lib settings`
Expected: compile error `cannot find function effective_relay_with`.

- [ ] **Step 3: Implement** (after `validate_relay_url`):

```rust
/// Relay baked in at build time (`release.yml` sets `YON_DEFAULT_RELAY`
/// from a repo variable). `None` in dev builds or when it is invalid.
pub fn default_relay() -> Option<String> {
    default_relay_from(option_env!("YON_DEFAULT_RELAY"))
}

fn default_relay_from(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    match validate_relay_url(raw) {
        Ok(url) => Some(url),
        Err(_) => {
            static LOGGED: std::sync::Once = std::sync::Once::new();
            LOGGED.call_once(|| eprintln!("[yon] ignoring invalid built-in relay"));
            None
        }
    }
}

/// The relay "Reach from anywhere" uses: the user's override, else the
/// built-in one. Normalized.
pub fn effective_relay(s: &Settings) -> Option<String> {
    effective_relay_with(s, default_relay())
}

fn effective_relay_with(s: &Settings, default: Option<String>) -> Option<String> {
    if s.relay_url.is_empty() {
        default
    } else {
        Some(s.relay_url.clone())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Note {
    /// Remote is on but this phone's link doesn't use the current relay.
    HomeOnly,
    /// Paired through a relay, but remote is off now.
    NeedsRemote,
}

/// Compares normalized URLs only, so equivalent spellings never ask the
/// user to pair again.
pub fn phone_note(p: &PairedPhone, remote_on: bool, effective: Option<&str>) -> Option<Note> {
    if remote_on {
        (Some(p.relay.as_str()) != effective).then_some(Note::HomeOnly)
    } else {
        (!p.relay.is_empty()).then_some(Note::NeedsRemote)
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --lib settings && cargo clippy --all-targets --all-features -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): built-in relay default and per-phone notes"
```

---

### Task 4: Authenticated signal in Link

**Files:**
- Modify: `src-tauri/src/link/mod.rs` (`Link` struct ~:115, `Link::new` ~:194, `Session` :120, `hello()` session literal ~:452, `sealed()` :491-505, add setter near `set_presence_listener` :296)
- Test: `src-tauri/tests/link.rs`

**Interfaces:**
- Produces: `pub fn set_on_authenticated(&self, f: Arc<dyn Fn([u8; 16]) + Send + Sync>)` — called once per session, with the phone id, after the first request that opens under the pairing key.

- [ ] **Step 1: Write the failing test** (append to `tests/link.rs`)

```rust
#[tokio::test]
async fn authenticated_fires_only_after_valid_sealed_request() {
    let env = setup("authed", Mode::Accept).await;
    let seen = Arc::new(Mutex::new(Vec::<[u8; 16]>::new()));
    let log = seen.clone();
    env.link
        .set_on_authenticated(Arc::new(move |id| log.lock().unwrap().push(id)));

    // /hello alone proves nothing.
    let mut p = FakePhone::hello(env.addr, &env.phone).await;
    assert!(seen.lock().unwrap().is_empty(), "hello");
    // Wrong key → bad tag.
    let mut wrong = FakePhone::hello(
        env.addr,
        &Phone {
            key: [0x44; 32],
            ..env.phone.clone()
        },
    )
    .await;
    assert_eq!(wrong.call("POST", "/status", b"").await.0, 404);
    assert!(seen.lock().unwrap().is_empty(), "bad tag");

    // First valid sealed request fires once; later ones and replays don't.
    assert_eq!(p.call("POST", "/status", b"").await.0, 200);
    assert_eq!(p.raw_call("POST", "/status", b"", 1).await.0, 404, "replay");
    assert_eq!(p.call("POST", "/status", b"").await.0, 200);
    assert_eq!(*seen.lock().unwrap(), vec![env.phone.id]);

    // A new session fires again.
    let mut again = FakePhone::hello(env.addr, &env.phone).await;
    assert_eq!(again.call("POST", "/status", b"").await.0, 200);
    assert_eq!(seen.lock().unwrap().len(), 2);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --test link authenticated_fires_only_after_valid_sealed_request`
Expected: compile error `no method named set_on_authenticated`.

- [ ] **Step 3: Implement**

In `struct Link`, after `on_presence`:

```rust
    /// Called once per session when a phone first proves its pairing key.
    on_authenticated: RwLock<Option<Arc<dyn Fn([u8; 16]) + Send + Sync>>>,
```

In `Link::new`, after `on_presence: RwLock::new(None),`: `on_authenticated: RwLock::new(None),`

In `struct Session`, after `upload`: 

```rust
    /// The pairing key has been proven in this session (see `sealed`).
    authed: bool,
```

In `hello()`'s `Session { … }` literal add `authed: false,`.

After `set_presence_listener`:

```rust
    /// Called once per session, with the phone id, after the first request
    /// that opened under the pairing key. Never from `/hello`, a bad tag,
    /// or a replay.
    pub fn set_on_authenticated(&self, f: Arc<dyn Fn([u8; 16]) + Send + Sync>) {
        *self.on_authenticated.write().expect("lock") = Some(f);
    }
```

In `sealed()`, right after `s.inbound.mark(ctr);`:

```rust
        if !s.authed {
            s.authed = true;
            let f = self.on_authenticated.read().expect("lock").clone();
            if let Some(f) = f {
                f(s.phone_id);
            }
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --test link && cargo clippy --all-targets --all-features -- -D warnings`
Expected: all link tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/link/mod.rs src-tauri/tests/link.rs
git commit -m "feat(link): signal when a session first proves the pairing key"
```

---

### Task 5: Backend wiring (commands, DTOs, timer, event, CI variable)

**Files:**
- Modify: `src-tauri/src/app.rs` (AppState, DTOs, `setup`, `sync_remote`, `settings_dto`, `pair_phone`, `set_remote`, new `cancel_pairing`, helpers)
- Modify: `src-tauri/src/lib.rs:100-101` (register command)
- Modify: `.github/workflows/release.yml` (tauri step `env:`)

**Interfaces:**
- Consumes: Task 1–4 functions.
- Produces (Tauri commands and events the UI uses):
  - `pair_phone(name: String, replaces: Option<String>) -> PairDto`
  - `cancel_pairing(id: String) -> CancelDto { outcome: "cancelled" | "completed" | "not_found", settings: SettingsDto }`
  - `set_remote(enabled: bool, relay_url: String) -> SettingsDto` (empty `relay_url` = use the built-in relay)
  - `PhoneDto { id, name, created, note: Option<Note>, pending: bool }`
  - `SettingsDto` gains `default_relay: Option<String>`, `effective_relay: Option<String>`
  - event `settings-changed` with `SettingsDto`

This task has no new unit tests of its own: the logic it calls is tested in Tasks 1–4, and the glue is exercised by the gate and the manual check in Step 9.

- [ ] **Step 1: Helpers and state.** Add near the top of `app.rs` (after the imports):

```rust
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
```

Add to `AppState` after `remote_status`:

```rust
    /// The pending-pairing expiry loop is running. Changed only while the
    /// settings lock is held, so a new pending pairing can't be missed.
    expiry_running: AtomicBool,
```

and in `setup`'s `AppState { … }`: `expiry_running: AtomicBool::new(false),`.

- [ ] **Step 2: DTOs.** Replace `PhoneDto` and extend `SettingsDto`:

```rust
#[derive(Serialize)]
struct PhoneDto {
    id: String,
    name: String,
    created: u64,
    note: Option<settings::Note>,
    /// Waiting for "Pair again" to be confirmed; hidden in the list.
    pending: bool,
}

#[derive(Serialize)]
struct CancelDto {
    outcome: &'static str,
    settings: SettingsDto,
}
```

In `SettingsDto` after `relay_url`:

```rust
    /// Built-in relay of this build (normalized), if any.
    default_relay: Option<String>,
    /// Relay "Reach from anywhere" uses: the override, else the built-in.
    effective_relay: Option<String>,
```

Make `CancelDto` `pub` if clippy asks (it is returned from a `pub` command).

In `settings_dto`, compute `let effective = settings::effective_relay(&s);` first, then:

```rust
            phones: s
                .phones
                .iter()
                .map(|p| PhoneDto {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    created: p.created,
                    note: settings::phone_note(p, s.remote, effective.as_deref()),
                    pending: p.replaces.is_some(),
                })
                .collect(),
```

and after `relay_url: s.relay_url.clone(),`:

```rust
            default_relay: settings::default_relay(),
            effective_relay: effective,
```

- [ ] **Step 3: Relay connection uses the effective relay.** In `sync_remote`, replace `s.relay_url.clone(),` with `settings::effective_relay(&s).unwrap_or_default(),`.

- [ ] **Step 4: Pairing-state methods on `AppState`** (add in `impl AppState`):

```rust
    fn emit_settings(&self) {
        let _ = self.app.emit("settings-changed", self.settings_dto());
    }

    /// A phone proved its key; finish a "Pair again" if it was pending.
    async fn complete_pairing(&self, id: &str) {
        let changed = {
            let mut s = self.settings.lock().expect("lock");
            match settings::complete_replacement(&s, id, |n| n.save(&self.data_dir)) {
                Ok(Some(next)) => {
                    *s = next;
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    eprintln!("[yon] couldn't save pairing change: {e}");
                    false
                }
            }
        };
        if changed {
            self.sync_link().await;
            self.emit_settings();
        }
    }

    /// Drop expired pending pairings. Returns whether any pending remain.
    async fn expire_pairings(&self) -> bool {
        let (changed, pending) = {
            let mut s = self.settings.lock().expect("lock");
            let changed = match settings::expire_pending(&s, unix_now(), |n| n.save(&self.data_dir)) {
                Ok(Some(next)) => {
                    *s = next;
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    eprintln!("[yon] couldn't save pairing change: {e}");
                    false
                }
            };
            let pending = s.has_pending();
            if !pending {
                // WHY: cleared under the settings lock — `pair_phone` adds a
                // pending record under the same lock, then starts the loop.
                self.expiry_running.store(false, Ordering::SeqCst);
            }
            (changed, pending)
        };
        if changed {
            self.sync_link().await;
            self.emit_settings();
        }
        pending
    }

    /// Run the 60 s expiry loop while pending pairings exist.
    fn ensure_expiry_timer(&self) {
        if self.expiry_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let Some(state) = app.try_state::<AppState>() else {
                    continue;
                };
                if !state.expire_pairings().await {
                    break;
                }
            }
        });
    }
```

`Settings` is already imported in `app.rs` (used by `setup`); no new imports are needed for this step.

- [ ] **Step 5: Startup.** In `setup`, right after `let settings = Settings::load(&data_dir, &downloads);` replace it with:

```rust
    let mut settings = Settings::load(&data_dir, &downloads);
    // WHY: before Link starts, so a pairing left pending by a crash or a
    // forced quit can't authenticate after its time is up.
    match settings::expire_pending(&settings, unix_now(), |n| n.save(&data_dir)) {
        Ok(Some(next)) => settings = next,
        Ok(None) => {}
        Err(e) => eprintln!("[yon] couldn't save pairing change: {e}"),
    }
    let has_pending = settings.has_pending();
```

After `state.set_presence_listener(...)` block add:

```rust
    let auth_app = app.clone();
    state.link.set_on_authenticated(Arc::new(move |id| {
        // WHY: called from inside a Link request; finish on another task
        // so saving and `sync_link` never run under Link's session lock.
        let app = auth_app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(state) = app.try_state::<AppState>() {
                state.complete_pairing(&hex(&id)).await;
            }
        });
    }));
    if has_pending {
        state.ensure_expiry_timer();
    }
```

- [ ] **Step 6: `pair_phone`.** Replace the whole command:

```rust
/// Pair a phone, or with `replaces` start "Pair again" for an existing one:
/// the new pairing stays pending (the old one keeps working) until the phone
/// proves the new key. The key leaves Rust only inside this one-time URL.
#[tauri::command]
pub async fn pair_phone(
    state: State<'_, AppState>,
    name: String,
    replaces: Option<String>,
) -> Result<PairDto, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let name = settings::validate_name(&name)?;
    let (mut id, mut key) = ([0u8; 16], [0u8; 32]);
    let rng = SystemRandom::new();
    rng.fill(&mut id)
        .and_then(|_| rng.fill(&mut key))
        .map_err(|_| "Couldn't create a pairing key")?;
    state.expire_pairings().await;
    let anywhere_relay = {
        let mut s = state.settings.lock().expect("lock");
        if let Some(old) = &replaces {
            if !s.phones.iter().any(|p| p.id == *old && p.replaces.is_none()) {
                return Err("Unknown phone".into());
            }
        }
        let relay = settings::effective_relay(&s).filter(|_| s.remote);
        let mut next = s.clone();
        if let Some(old) = &replaces {
            // A second "Pair again" for the same phone supersedes the first.
            next.phones.retain(|p| p.replaces.as_ref() != Some(old));
        }
        if !next.add_phone(settings::PairedPhone {
            id: hex(&id),
            key: hex(&key),
            name: name.clone(),
            created: unix_now(),
            relay: relay.clone().unwrap_or_default(),
            replaces: replaces.clone(),
        }) {
            return Err("Too many phones paired. Remove one first.".into());
        }
        next.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
        *s = next;
        relay
    };
    // WHY: started after the lock is released; the loop clears its flag
    // under the settings lock, so this new pending record can't be missed.
    if replaces.is_some() {
        state.ensure_expiry_timer();
    }
    state.sync_link().await;
    let phone = Phone { id, key, name };
    let anywhere = {
        let s = state.settings.lock().expect("lock");
        match (unhex::<32>(&s.room_secret), &anywhere_relay) {
            (Some(secret), Some(relay)) => Some(link::anywhere_url(
                &phone,
                &remote::room_id(&secret),
                relay,
            )),
            _ => None,
        }
    };
    let (qr, fallback) = match &anywhere {
        // WHY: no Wi-Fi-only code in anywhere mode — one pairing, one link.
        Some(url) => (QrDto::new(url.clone())?, None),
        None => (
            QrDto::new(link::pairing_url(&state.link_host(), &phone))?,
            match link::lan_ipv4() {
                Some(ip) => Some(QrDto::new(link::pairing_url(&ip.to_string(), &phone))?),
                None => None,
            },
        ),
    };
    Ok(PairDto {
        phone_id: hex(&id),
        qr,
        fallback,
        anywhere: anywhere.is_some(),
        settings: state.settings_dto(),
    })
}
```

- [ ] **Step 7: `cancel_pairing` and `set_remote`.** Add after `unpair_phone`:

```rust
/// The pairing sheet closed before a "Pair again" was confirmed.
#[tauri::command]
pub async fn cancel_pairing(state: State<'_, AppState>, id: String) -> Result<CancelDto, String> {
    let (outcome, changed) = {
        let mut s = state.settings.lock().expect("lock");
        match settings::cancel_pending(&s, &id, |n| n.save(&state.data_dir)) {
            Ok(settings::CancelOutcome::Cancelled(next)) => {
                *s = next;
                ("cancelled", true)
            }
            Ok(settings::CancelOutcome::Completed) => ("completed", false),
            Ok(settings::CancelOutcome::NotFound) => ("not_found", false),
            Err(e) => {
                eprintln!("[yon] couldn't save pairing change: {e}");
                return Err(format!("Could not save settings: {e}"));
            }
        }
    };
    if changed {
        state.sync_link().await;
    }
    Ok(CancelDto {
        outcome,
        settings: state.settings_dto(),
    })
}
```

Replace the body of `set_remote` (keep its doc comment and signature):

```rust
    let relay_url = settings::validate_relay_url(&relay_url)?;
    {
        let mut s = state.settings.lock().expect("lock");
        let mut next = s.clone();
        next.remote = enabled;
        next.relay_url = relay_url;
        if enabled && settings::effective_relay(&next).is_none() {
            return Err("Add a relay address under Advanced to turn this on.".into());
        }
        if enabled && next.room_secret.is_empty() {
            use ring::rand::{SecureRandom, SystemRandom};
            let mut secret = [0u8; 32];
            SystemRandom::new()
                .fill(&mut secret)
                .map_err(|_| "Couldn't create a room secret")?;
            next.room_secret = hex(&secret);
        }
        next.save(&state.data_dir)
            .map_err(|e| format!("Could not save settings: {e}"))?;
        *s = next;
    }
    state.sync_link().await;
    Ok(state.settings_dto())
```

In `src-tauri/src/lib.rs`, after `app::unpair_phone,` add `app::cancel_pairing,`.

- [ ] **Step 8: CI variable.** In `.github/workflows/release.yml`, in the `tauri` step's `env:` after `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`:

```yaml
          # Built-in relay for "Reach from anywhere" (settings.rs
          # default_relay); empty until the maintainer sets the variable.
          YON_DEFAULT_RELAY: ${{ vars.YON_DEFAULT_RELAY }}
```

- [ ] **Step 9: Verify**

Run: `cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets --all-features -- -D warnings`
Expected: all PASS.

Build-default check: `cd src-tauri && YON_DEFAULT_RELAY=wss://relay.example.com cargo build --release && strings target/release/yon | grep -c 'wss://relay.example.com'` → `1` or more; then `cargo build --release` without the variable and confirm the count is `0` (cargo rebuilds when an `option_env!` variable changes).

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/app.rs src-tauri/src/lib.rs .github/workflows/release.yml
git commit -m "feat(app): built-in relay, Pair again commands and pending expiry"
```

---

### Task 6: API types and the settings event

**Files:**
- Modify: `src/api.ts`, `src/App.tsx:68-75`

**Interfaces:**
- Produces: `PhoneNote`, `Phone` type, `CancelResult`, `api.pairPhone(name, replaces?)`, `api.cancelPairing(id)`, `Events["settings-changed"]`.

- [ ] **Step 1: Types.** In `api.ts` replace the `phones:` line in `Settings` and add after `relay_url`:

```ts
  phones: Phone[];
```

```ts
  /** Built-in relay of this build, if any (normalized URL). */
  default_relay: string | null;
  /** Relay in use when Reach from anywhere is on: override, else built-in. */
  effective_relay: string | null;
```

Add after `Settings`:

```ts
/** home_only: remote is on but this phone's link isn't through the current relay. */
export type PhoneNote = "home_only" | "needs_remote";

export interface Phone {
  id: string;
  name: string;
  created: number;
  note: PhoneNote | null;
  /** A "Pair again" not confirmed yet; not shown, not a send target. */
  pending: boolean;
}

export interface CancelResult {
  outcome: "cancelled" | "completed" | "not_found";
  settings: Settings;
}
```

- [ ] **Step 2: Commands and event.** Replace `pairPhone` and add `cancelPairing`:

```ts
  pairPhone: (name: string, replaces?: string) =>
    invoke<Pairing>("pair_phone", { name, replaces: replaces ?? null }),
  cancelPairing: (id: string) => invoke<CancelResult>("cancel_pairing", { id }),
```

In `Events` add `"settings-changed": Settings;`.

In `allDevices`, change `state.settings.phones.map(` to `state.settings.phones.filter((p) => !p.pending).map(`.

- [ ] **Step 3: App listener.** In `App.tsx`, next to the `remote-status` listener:

```tsx
      on("settings-changed", (settings) => setState((s) => (s ? { ...s, settings } : s))),
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint`
Expected: typecheck errors only in `SettingsSheet.tsx`/`PairPhoneSheet.tsx` if they use removed shapes; otherwise clean. (Fixed in Tasks 7–8; commit after Task 8 if typecheck fails here.)

- [ ] **Step 5: Commit** (if typecheck is clean)

```bash
git add src/api.ts src/App.tsx
git commit -m "feat(ui): pairing types, cancel command and settings-changed event"
```

---

### Task 7: Settings → Phones

**Files:**
- Modify: `src/components/SettingsSheet.tsx`

- [ ] **Step 1: State and handlers.** Replace `const [pairing, setPairing] = useState(false);` with:

```tsx
  const [pairing, setPairing] = useState<{ replace?: { id: string; name: string } } | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
```

Replace `setRemote` with:

```tsx
  async function setRemote(enabled: boolean) {
    setError(null);
    try {
      const settings = await api.setRemote(enabled, state.settings.relay_url);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  // Saved when the field loses focus; a bad address keeps the old one.
  async function saveRelay() {
    if (relayUrl.trim() === state.settings.relay_url) return;
    setRelayError(null);
    try {
      const settings = await api.setRemote(state.settings.remote, relayUrl);
      setRelayUrl(settings.relay_url);
      onChange({ ...state, settings });
    } catch (err) {
      setRelayError(errorText(err));
      setRelayUrl(state.settings.relay_url);
    }
  }
```

Add above the component:

```tsx
/** "wss://relay.example.com" → "relay.example.com" */
const hostOf = (url: string) => url.replace(/^wss?:\/\//, "");
```

- [ ] **Step 2: Phones list, toggle and hint.** Replace the `<div className="field"><span>Phones</span> … </div>` block (lines 192-235) with:

```tsx
        <div className="field">
          <span>Phones</span>
          {state.settings.phones.every((p) => p.pending) ? (
            <p className="hint">Send photos from your phone to this computer. No app needed.</p>
          ) : (
            <ul className="trusted">
              {state.settings.phones
                .filter((p) => !p.pending)
                .map((p) => (
                  <li key={p.id}>
                    <span className="file-name">
                      {p.name}
                      {p.note === "home_only" && <span className="hint"> Home Wi-Fi only</span>}
                      {p.note === "needs_remote" && (
                        <span className="hint"> Needs Reach from anywhere</span>
                      )}
                    </span>
                    {p.note === "home_only" && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => setPairing({ replace: { id: p.id, name: p.name } })}
                      >
                        Pair again
                      </button>
                    )}
                    <button type="button" className="link" onClick={() => unpair(p.id)}>
                      Remove
                    </button>
                  </li>
                ))}
            </ul>
          )}
          {state.settings.link_error && <p className="hint bad">{state.settings.link_error}</p>}
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.remote}
              disabled={!state.settings.remote && !state.settings.effective_relay}
              onChange={(e) => setRemote(e.target.checked)}
            />
            <span>
              Reach from anywhere
              <span className="hint">
                {state.settings.effective_relay
                  ? `Through ${hostOf(state.settings.effective_relay)}. It passes on encrypted data only; it can see internet addresses, when devices connect and how much they send.`
                  : "Add a relay address under Advanced to turn this on."}
              </span>
            </span>
          </label>
          {state.settings.remote && <RemoteLine status={state.settings.remote_status} />}
          <button type="button" className="quiet pair-button" onClick={() => setPairing({})}>
            Pair a phone
          </button>
        </div>
```

- [ ] **Step 3: Relay address under Advanced.** Inside `<details>`, after the port `<p className="hint">…</p>`:

```tsx
          <label className="field">
            <span>Relay address</span>
            <input
              placeholder={
                state.settings.default_relay
                  ? hostOf(state.settings.default_relay)
                  : "wss://relay.example.com"
              }
              value={relayUrl}
              spellCheck={false}
              onChange={(e) => setRelayUrl(e.target.value)}
              onBlur={saveRelay}
            />
          </label>
          <p className={relayError ? "hint bad" : "hint"}>
            {relayError ??
              (state.settings.default_relay
                ? "Leave empty to use the built-in relay."
                : "Required to turn on Reach from anywhere.")}
          </p>
```

- [ ] **Step 4: Sheet props.** Replace the `{pairing && <PairPhoneSheet … />}` block with:

```tsx
      {pairing && (
        <PairPhoneSheet
          online={state.online_phones}
          phones={state.settings.phones}
          replace={pairing.replace}
          onPaired={(settings) => onChange({ ...state, settings })}
          onClose={() => setPairing(null)}
        />
      )}
```

- [ ] **Step 5: Verify** — `bun run typecheck` reports only the missing `phones`/`replace` props on `PairPhoneSheet` (fixed in Task 8). No commit yet.

---

### Task 8: Pairing sheet replace mode

**Files:**
- Modify: `src/components/PairPhoneSheet.tsx`

- [ ] **Step 1: Props and state.** Replace the `Props` interface and the top of the component (through the `connected` effect) with:

```tsx
interface Props {
  /** Phones whose Yon page is open (ids); tells us the scan worked. */
  online: string[];
  /** Current phones, kept fresh by the settings-changed event. */
  phones: Phone[];
  /** "Pair again": replace this phone's pairing once the new one is proven. */
  replace?: { id: string; name: string };
  onPaired: (s: Settings) => void;
  onClose: () => void;
}

/** How long "Paired" stays up before the sheet closes itself. */
const CONNECTED_MS = 2500;

/** Pair a phone for Yon Link: name it, then scan the QR once. */
export default function PairPhoneSheet({ online, phones, replace, onPaired, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(replace?.name ?? "My phone");
  const [qr, setQr] = useState<{ id: string; main: Qr; fallback: Qr | null; anywhere: boolean } | null>(
    null,
  );
  const [useIp, setUseIp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forced, setForced] = useState<"paired" | "expired" | null>(null);
  useEffect(() => ref.current?.showModal(), []);
  // Normal pairing: the phone opened its page. Pair again: the backend
  // confirmed the new key (the pairing is no longer pending) — presence
  // alone doesn't count, the old icon is online too.
  const confirmed = replace
    ? qr !== null && phones.some((p) => p.id === qr.id && !p.pending)
    : qr !== null && online.includes(qr.id);
  const paired = confirmed || forced === "paired";
  useEffect(() => {
    if (!confirmed || replace) return; // replace mode waits for Done: there is a step to read
    const t = window.setTimeout(onClose, CONNECTED_MS);
    return () => window.clearTimeout(t);
  }, [confirmed, replace, onClose]);

  /** Closing before a "Pair again" is confirmed drops the pending pairing. */
  async function close() {
    if (replace && qr && !paired && forced === null) {
      try {
        const r = await api.cancelPairing(qr.id);
        onPaired(r.settings);
        if (r.outcome === "completed") return setForced("paired");
        if (r.outcome === "not_found") return setForced("expired");
      } catch (err) {
        return setError(errorText(err));
      }
    }
    onClose();
  }
```

Import `Phone` in the `../api` import: `import { api, errorText, type Phone, type Qr, type Settings } from "../api";`

- [ ] **Step 2: Pair call.** In `pair()` replace `api.pairPhone(name)` with `api.pairPhone(name, replace?.id)`.

- [ ] **Step 3: Render.** Replace the `return ( <dialog …> … </dialog> );` block with:

```tsx
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="pair-title"
      onCancel={(e) => {
        e.preventDefault();
        void close();
      }}
    >
      {forced === "expired" ? (
        <div className="pair" role="status">
          <h2 id="pair-title">This code expired. Pair again.</h2>
          <p className="hint">{replace?.name ?? name} still works as before.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : paired ? (
        <div className="pair paired" role="status">
          <span className="paired-check" aria-hidden>
            ✓
          </span>
          <h2 id="pair-title">{name} is paired</h2>
          <p className="hint">
            {replace
              ? "Paired. On the phone, delete the old Yon icon from the Home Screen, then tap Share → Add to Home Screen on this page."
              : "Send from the phone with the Yon icon, or pick it in Yon to send files to it."}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : !shown ? (
        <form onSubmit={pair}>
          <h2 id="pair-title">{replace ? `Pair ${replace.name} again` : "Pair a phone"}</h2>
          <p className="hint">
            {replace
              ? "Makes a new link that works on any network. The current one keeps working until the phone opens the new one."
              : "Send photos and files from an iPhone or Android phone to this computer. No app to install: you scan a code once and keep a Yon icon on your Home Screen."}
          </p>
          {!replace && (
            <label className="field">
              <span>Phone name</span>
              <input
                value={name}
                maxLength={63}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </label>
          )}
          {error && <p className="hint bad">{error}</p>}
          <div className="actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              Show code
            </button>
          </div>
        </form>
      ) : (
        <div className="pair">
          <h2 id="pair-title">Scan with {name}</h2>
          <QrCode qr={shown} />
          <ol className="steps">
            <li>Open the Camera on your phone and point it at the code.</li>
            <li>
              {qr.anywhere
                ? "Tap the link. Works on any network."
                : "Tap the link. The phone must be on the same Wi-Fi as this computer."}
            </li>
            {replace ? (
              <li>Keep this window open. It confirms when the phone connects.</li>
            ) : (
              <li>
                Tap Share, then <b>Add to Home Screen</b> (Android: menu ⋮, then Add to Home
                screen). Next time, just tap the Yon icon.
              </li>
            )}
          </ol>
          {qr.fallback && (
            <button type="button" className="link" onClick={() => setUseIp(!useIp)}>
              {useIp ? "Use the normal code" : "Link doesn't open? Try this code instead"}
            </button>
          )}
          <p className="hint">
            {useIp
              ? "This code uses the computer's current IP address, so it may stop working when your Wi-Fi changes it."
              : qr.anywhere
                ? "Works on any network through the relay. Anyone who scans it can ask to send you files; remove the phone in Settings to stop it."
                : "Anyone who scans this code can ask to send you files. Remove the phone in Settings to stop it."}
          </p>
          {error && <p className="hint bad">{error}</p>}
          <div className="actions">
            <button type="button" className="primary" onClick={() => void close()}>
              Done
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
```

(`qr.fallback` is always `null` in anywhere mode now, so the old "Only use it at home?" branch is gone.)

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test web/ relay/`
Expected: all clean/PASS.

- [ ] **Step 5: Commit** (includes Task 6 files if they were not committed)

```bash
git add src/api.ts src/App.tsx src/components/SettingsSheet.tsx src/components/PairPhoneSheet.tsx
git commit -m "feat(ui): one-click Reach from anywhere and Pair again"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/adr/ADR-003-yon-link-anywhere-relay.md`, `docs/threat-model-link-relay.md`, `README.md:59`

- [ ] **Step 1: ADR-003.** Append at the end:

```markdown
## Addendum (2026-09-28): built-in relay and "Pair again"

- Release builds carry a default relay, set at build time from the repo
  variable `YON_DEFAULT_RELAY` (`settings::default_relay`). No hostname is in
  the source. Dev builds have none. The user can still enter their own relay
  under Settings → Advanced; it replaces the built-in one.
- "Reach from anywhere" stays off by default; with a built-in relay it is
  one click. When it is on, every new pairing goes through the relay, at home
  too (the HTTPS page can't reach the computer's `http://` LAN address).
- Phones paired before, or to another relay, show "Home Wi-Fi only · Pair
  again". Pair again creates a pending pairing; the old one keeps working
  until the phone proves the new key, then the old one is removed. A pending
  pairing that never connects is dropped after 15 minutes.
- Spec: `docs/superpowers/specs/2026-09-28-anywhere-default-relay-design.md`.
```

- [ ] **Step 2: Threat model.** Append at the end of `docs/threat-model-link-relay.md`:

```markdown
### Built-in relay (v0.2.2)

- **Who runs it:** the maintainer, on their own server behind Cloudflare
  Tunnel. Users who don't want that set their own relay address.
- **What it sees:** internet addresses of the computer and phones, when they
  connect, and how much they send. Contents stay encrypted end to end with
  the pairing key; the relay never holds it.
- **Pair again:** the old pairing is removed only after the new key is
  proven in an authenticated session, so a scanned-but-abandoned code can't
  lock the user out; unused pending pairings expire after 15 minutes and at
  startup.
```

- [ ] **Step 3: README.** Replace the paragraph at `README.md:59` with:

```markdown
**From anywhere (optional).** Turn on **Settings → Phones → Reach from anywhere**. Release builds come with a relay run by the maintainer; to use your own, enter it under **Settings → Advanced → Relay address**. New pairings then open the phone page from GitHub Pages and reach this computer through the relay, on any network. The relay only passes on encrypted data and stores nothing; it does see internet addresses, when devices connect and how much they send. Phones paired before show **Pair again**: scan the new code, and the old link keeps working until the phone connects with the new one. Run your own relay: `YON_RELAY_TAG=dev docker compose up -d --build` in `relay/` (it listens on 127.0.0.1 only; put Cloudflare Tunnel or another TLS proxy in front), then `bun relay/check.ts wss://<your host>` to check the WebSocket path end to end. `.github/workflows/relay.yml` + `relay/deploy.sh` deploy it with health checks and rollback.
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/ADR-003-yon-link-anywhere-relay.md docs/threat-model-link-relay.md README.md
git commit -m "docs: built-in relay, what it sees, and Pair again"
```

---

### Task 10: Full gate and manual check

- [ ] **Step 1: Gate**

```bash
cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets --all-features -- -D warnings && cd .. && bun test web/ relay/ && bun run typecheck && bun run lint
```

Expected: every command exits 0.

- [ ] **Step 2: Manual (dev build, isolated data dir).** `YON_DATA_DIR=<scratch> YON_DEFAULT_RELAY=wss://relay.example.com bun tauri dev`:
  1. Settings shows "Through relay.example.com…"; Advanced placeholder `relay.example.com`, hint "Leave empty to use the built-in relay."
  2. Without `YON_DEFAULT_RELAY`: toggle disabled, hint "Add a relay address under Advanced to turn this on."; entering `http://x` shows the error under the field and keeps the old value.
  3. Pair a phone with remote off, then turn remote on → the phone shows "Home Wi-Fi only" and **Pair again**; opening Pair again and pressing Done before scanning → phone list unchanged (pending cancelled).

End-to-end with a real phone and relay is the spec's acceptance step 7 (after release), not part of this plan.

---

## Self-review

- **Spec coverage:** settings fields/normalization (T1–T3), effective relay & invalid default log (T3), notes (T3), complete/cancel/expire + change rule + TTL rules (T2), startup/60 s/pair_phone expiry (T5), authenticated signal (T4), commands `set_remote`/`pair_phone`/`cancel_pairing`, DTO `note`/`pending`, no fallback in anywhere mode, `settings-changed` (T5), `release.yml` (T5), UI toggle/Advanced/notes/Pair again (T7), sheet replace mode, done signal, icon step, close-cancels, expired text (T8), api/App (T6), docs (T9), every listed unit test and the integration test (T1–T4), gate (T10). Error table: "Enable with no effective relay" (T5 step 7, T7 hint), invalid override (T7 step 1), invalid default (T3), save fails (T2/T5 logging), phone limit (T5 `add_phone`), sheet past TTL (T8 `not_found`), old icon 404 (page text kept — Addition 4).
- **Placeholders:** none.
- **Type consistency:** `complete_replacement`/`cancel_pending`/`expire_pending`/`CancelOutcome`/`Note`/`phone_note`/`effective_relay`/`default_relay`/`has_pending`/`set_on_authenticated`/`PhoneDto.note|pending`/`CancelDto.outcome`/`Phone`/`CancelResult` match across tasks.
