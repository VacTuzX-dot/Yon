//! User settings persisted as JSON in the app data dir.

use crate::identity::{parse_fingerprint, Fingerprint};
use crate::protocol::{hex, MAX_DEVICE_NAME_BYTES};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const FILE: &str = "settings.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub device_name: String,
    pub save_dir: PathBuf,
    pub port: u16,
    /// Closing the window hides it (tray keeps Yon receiving). Ignored on
    /// macOS, where closing always hides. Missing in old files → true.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// macOS only: false = menu-bar-only app (no Dock icon).
    #[serde(default = "default_true")]
    pub show_in_dock: bool,
    /// Devices whose transfers are accepted without asking. Matched by the
    /// key fingerprint proven in the TLS handshake — never by name.
    #[serde(default)]
    pub trusted: Vec<TrustedDevice>,
    /// Phones paired for Yon Link. `key` is the pairing secret (hex); it is
    /// never sent to the UI after the QR is shown.
    #[serde(default)]
    pub phones: Vec<PairedPhone>,
    /// Look for a new version on GitHub Releases (the only request Yon makes
    /// outside the local network). Missing in old files → true.
    #[serde(default = "default_true")]
    pub check_updates: bool,
    /// Yon Link through a relay (ADR-003). Off unless turned on.
    #[serde(default)]
    pub remote: bool,
    /// e.g. `wss://relay.example.com`.
    #[serde(default)]
    pub relay_url: String,
    /// 32-byte hex; proves to the relay that this computer owns its room.
    /// Created the first time "Reach from anywhere" is turned on.
    #[serde(default)]
    pub room_secret: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedPhone {
    /// 16-byte pair id, hex.
    pub id: String,
    /// 32-byte pairing key, hex.
    pub key: String,
    pub name: String,
    /// Unix seconds.
    pub created: u64,
    /// Relay this pairing was made for (normalized URL); empty = home
    /// Wi-Fi only. Missing in files from before v0.2.2 → empty.
    #[serde(default)]
    pub relay: String,
    /// Set only while this pairing is pending: id of the pairing it
    /// replaces once it has proven its key.
    #[serde(default)]
    pub replaces: Option<String>,
}

const MAX_PHONES: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedDevice {
    /// Full SHA-256 fingerprint, lowercase hex.
    pub id: String,
    /// Name when last seen; display only.
    pub name: String,
}

const MAX_TRUSTED: usize = 100;

fn default_true() -> bool {
    true
}

impl Settings {
    pub fn defaults(downloads: &Path) -> Self {
        Self {
            device_name: crate::platform::default_device_name(),
            save_dir: downloads.join("Yon"),
            port: crate::server::DEFAULT_PORT,
            close_to_tray: true,
            show_in_dock: true,
            trusted: Vec::new(),
            phones: Vec::new(),
            check_updates: true,
            remote: false,
            relay_url: String::new(),
            room_secret: String::new(),
        }
    }

    /// Load from `data_dir`; missing or corrupt file → defaults.
    pub fn load(data_dir: &Path, downloads: &Path) -> Self {
        let defaults = Self::defaults(downloads);
        // WHY: 0.2.2 and older wrote this file world-readable (0644).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(data_dir.join(FILE), fs::Permissions::from_mode(0o600));
        }
        let text = match fs::read_to_string(data_dir.join(FILE)) {
            Ok(t) => t,
            Err(_) => return defaults,
        };
        match serde_json::from_str::<Settings>(&text) {
            Ok(mut s) => {
                s.device_name = validate_name(&s.device_name).unwrap_or(defaults.device_name);
                if validate_port(s.port).is_err() {
                    s.port = defaults.port;
                }
                if !s.save_dir.is_absolute() {
                    s.save_dir = defaults.save_dir;
                }
                // A hand-edited or corrupt entry must not match anything.
                s.trusted.retain(|t| parse_fingerprint(&t.id).is_some());
                s.trusted.truncate(MAX_TRUSTED);
                s.phones.retain(|p| {
                    crate::protocol::unhex::<16>(&p.id).is_some()
                        && crate::protocol::unhex::<32>(&p.key).is_some()
                });
                s.phones.truncate(MAX_PHONES);
                for p in &mut s.phones {
                    p.relay = validate_relay_url(&p.relay).unwrap_or_default();
                }
                if crate::protocol::unhex::<32>(&s.room_secret).is_none() {
                    s.room_secret.clear();
                }
                // Stored normalized, so an override saved by an older
                // version compares equal to the same relay spelled now.
                s.relay_url = validate_relay_url(&s.relay_url).unwrap_or_default();
                s
            }
            Err(e) => {
                eprintln!("[yon] settings.json unreadable, using defaults: {e}");
                defaults
            }
        }
    }

    pub fn is_trusted(&self, fp: &Fingerprint) -> bool {
        let id = hex(fp);
        self.trusted.iter().any(|t| t.id == id)
    }

    /// Add (or refresh the name of) a trusted device.
    pub fn trust(&mut self, fp: &Fingerprint, name: &str) {
        let id = hex(fp);
        let name = validate_name(name).unwrap_or_else(|_| "Unknown device".into());
        if let Some(t) = self.trusted.iter_mut().find(|t| t.id == id) {
            t.name = name;
        } else if self.trusted.len() < MAX_TRUSTED {
            self.trusted.push(TrustedDevice { id, name });
        }
    }

    /// Add a phone if there's room. Returns false when the list is full.
    pub fn add_phone(&mut self, phone: PairedPhone) -> bool {
        if self.phones.len() >= MAX_PHONES {
            return false;
        }
        self.phones.push(phone);
        true
    }

    pub fn remove_phone(&mut self, id: &str) {
        self.phones.retain(|p| p.id != id);
    }

    pub fn untrust(&mut self, id: &str) {
        self.trusted.retain(|t| t.id != id);
    }

    /// Write atomically (temp file + rename) so a crash can't leave half a file.
    /// Owner-only (0600 on Unix): the file holds every phone's pairing key and
    /// the relay room secret, as sensitive as the identity key.
    pub fn save(&self, data_dir: &Path) -> io::Result<()> {
        use std::io::Write;
        fs::create_dir_all(data_dir)?;
        let tmp = data_dir.join(format!("{FILE}.tmp"));
        // A leftover from a crash; create_new below refuses anything else.
        let _ = fs::remove_file(&tmp);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        f.sync_all()?;
        fs::rename(tmp, data_dir.join(FILE))
    }
}

pub fn validate_name(raw: &str) -> Result<String, &'static str> {
    // Strip invisible/bidi characters too; count length on the raw input so
    // "too long" means what the user typed.
    let name = crate::sanitize::clean_display(raw, usize::MAX);
    let name = name.as_str();
    if name.is_empty() {
        return Err("Device name can't be empty");
    }
    if name.len() > MAX_DEVICE_NAME_BYTES {
        return Err("Device name is too long (max 63 bytes)");
    }
    Ok(name.to_string())
}

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

pub fn validate_port(port: u16) -> Result<u16, &'static str> {
    if port < 1024 {
        return Err("Port must be between 1024 and 65535");
    }
    Ok(port)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::tests::temp_dir;

    #[test]
    fn roundtrip_and_defaults() {
        let dir = temp_dir("settings");
        let dl = Path::new("/Users/x/Downloads");
        let d = Settings::load(&dir, dl);
        assert_eq!(d.save_dir, dl.join("Yon"));
        assert_eq!(d.port, 53420);

        let s = Settings {
            device_name: "Desk".into(),
            // WHY: must be absolute on Windows too, so no "/tmp/..." literal.
            save_dir: dir.join("y"),
            port: 60000,
            close_to_tray: false,
            show_in_dock: false,
            check_updates: false,
            remote: true,
            relay_url: "wss://relay.example.com".into(),
            room_secret: "ef".repeat(32),
            phones: vec![PairedPhone {
                id: "ab".repeat(16),
                key: "cd".repeat(32),
                name: "iPhone".into(),
                created: 1,
                relay: "wss://relay.example.com".into(),
                replaces: None,
            }],
            trusted: vec![TrustedDevice {
                id: "ab".repeat(32),
                name: "Desk".into(),
            }],
        };
        s.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir, dl), s);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn relay_urls_must_be_wss_or_local() {
        assert_eq!(
            validate_relay_url(" wss://r.example.com/ "),
            Ok("wss://r.example.com".into())
        );
        assert_eq!(
            validate_relay_url("ws://localhost:8787"),
            Ok("ws://localhost:8787".into())
        );
        assert_eq!(validate_relay_url(""), Ok(String::new()));
        assert!(validate_relay_url("ws://192.168.1.5:8787").is_err());
        assert!(validate_relay_url("http://r.example.com").is_err());
        assert!(validate_relay_url("wss://").is_err());
        assert!(validate_relay_url("wss://a b").is_err());
        // Phones can only parse host[:port] (web/link.ts).
        assert_eq!(
            validate_relay_url("wss://r.example.com:8443"),
            Ok("wss://r.example.com:8443".into())
        );
        assert!(validate_relay_url("wss://r.example.com/base").is_err());
        assert!(validate_relay_url("wss://r.example.com?x=1").is_err());
        assert!(validate_relay_url("wss://r.example.com:99999").is_err());
        assert!(validate_relay_url("wss://[::1]:8787").is_err());
    }

    #[test]
    fn relay_url_canonical_forms() {
        for raw in [
            "WSS://Relay.Example.com",
            "wss://relay.example.com/",
            "wss://relay.example.com:443",
            " wss://relay.example.com ",
        ] {
            assert_eq!(
                validate_relay_url(raw),
                Ok("wss://relay.example.com".into()),
                "{raw}"
            );
        }
        assert_eq!(
            validate_relay_url("wss://relay.example.com:8443"),
            Ok("wss://relay.example.com:8443".into())
        );
        assert_eq!(
            validate_relay_url("WS://LOCALHOST:80"),
            Ok("ws://localhost".into())
        );
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
        assert_eq!(
            Settings::load(&dir, dl).relay_url,
            "wss://relay.example.com"
        );
        fs::remove_dir_all(dir).unwrap();
    }

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
    fn saver(
        count: &std::cell::Cell<u32>,
        fail: bool,
    ) -> impl FnOnce(&Settings) -> io::Result<()> + '_ {
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
        assert_eq!(
            complete_replacement(&s, &id(1), saver(&saves, false)).unwrap(),
            None
        );
        assert_eq!(
            complete_replacement(&s, &id(9), saver(&saves, false)).unwrap(),
            None
        );
        assert_eq!(saves.get(), 0);
    }

    #[test]
    fn duplicate_auth_is_idempotent() {
        let s = with_phones(vec![phone(1, None, 10), phone(2, Some(1), 20)]);
        let saves = std::cell::Cell::new(0);
        let first = complete_replacement(&s, &id(2), saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(
            complete_replacement(&first, &id(2), saver(&saves, false)).unwrap(),
            None
        );
        assert_eq!(saves.get(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn settings_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::identity::tests::temp_dir("settings-mode");
        let file = dir.join(FILE);
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // An old world-readable file is tightened on load…
        fs::write(&file, b"{}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let s = Settings::load(&dir, &dir);
        assert_eq!(mode(&file), 0o600);
        // …and every save writes 0600, also over a stale temp file.
        fs::write(dir.join(format!("{FILE}.tmp")), b"stale").unwrap();
        s.save(&dir).unwrap();
        assert_eq!(mode(&file), 0o600);
        assert!(!dir.join(format!("{FILE}.tmp")).exists());
        assert_eq!(Settings::load(&dir, &dir).port, s.port);
        fs::remove_dir_all(dir).unwrap();
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
        let CancelOutcome::Cancelled(next) =
            cancel_pending(&s, &id(2), saver(&saves, false)).unwrap()
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
        assert_eq!(
            expire_pending(&s, 100 + PENDING_TTL - 1, saver(&saves, false)).unwrap(),
            None
        );
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
        assert_eq!(
            expire_pending(&s, 1_000 - 60, saver(&saves, false)).unwrap(),
            None
        );
        let next = expire_pending(&s, 1_000 - 61, saver(&saves, false))
            .unwrap()
            .unwrap();
        assert_eq!(next.phones, vec![phone(1, None, 10)]);
    }

    #[test]
    fn expiry_ignores_completed() {
        let s = with_phones(vec![phone(1, None, 0)]);
        let saves = std::cell::Cell::new(0);
        assert_eq!(
            expire_pending(&s, 1_000_000, saver(&saves, false)).unwrap(),
            None
        );
        assert_eq!(saves.get(), 0);
    }

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

    #[test]
    fn corrupt_or_invalid_values_fall_back() {
        let dir = temp_dir("settings-bad");
        let dl = Path::new("/d");
        fs::write(dir.join(FILE), "{not json").unwrap();
        assert_eq!(Settings::load(&dir, dl).port, 53420);

        fs::write(
            dir.join(FILE),
            r#"{"device_name":"  ","save_dir":"rel","port":80}"#,
        )
        .unwrap();
        let s = Settings::load(&dir, dl);
        assert_eq!(s.port, 53420);
        assert_eq!(s.save_dir, dl.join("Yon"));
        assert!(!s.device_name.trim().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_settings_file_defaults_close_to_tray_on() {
        let dir = temp_dir("settings-old");
        let json = format!(
            r#"{{"device_name":"Old","save_dir":{},"port":53420}}"#,
            serde_json::to_string(&dir).unwrap()
        );
        fs::write(dir.join(FILE), json).unwrap();
        let s = Settings::load(&dir, Path::new("/d"));
        assert!(s.close_to_tray && s.show_in_dock);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trust_is_by_fingerprint_and_survives_reload() {
        let dir = temp_dir("settings-trust");
        let dl = Path::new("/d");
        let mut s = Settings::load(&dir, dl);
        let (a, b) = ([1u8; 32], [2u8; 32]);
        assert!(!s.is_trusted(&a));
        s.trust(&a, "Leo's PC");
        s.trust(&a, "Renamed PC");
        assert!(s.is_trusted(&a) && !s.is_trusted(&b));
        assert_eq!(s.trusted.len(), 1, "no duplicates");
        assert_eq!(s.trusted[0].name, "Renamed PC");
        s.save(&dir).unwrap();
        assert!(Settings::load(&dir, dl).is_trusted(&a));
        s.untrust(&hex(&a));
        assert!(!s.is_trusted(&a));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_trusted_entries_are_dropped_on_load() {
        let dir = temp_dir("settings-trust-bad");
        let json = format!(
            r#"{{"device_name":"X","save_dir":{},"port":53420,
                "trusted":[{{"id":"not-hex","name":"evil"}},{{"id":"{}","name":"ok"}}]}}"#,
            serde_json::to_string(&dir).unwrap(),
            "cd".repeat(32)
        );
        fs::write(dir.join(FILE), json).unwrap();
        let s = Settings::load(&dir, Path::new("/d"));
        assert_eq!(s.trusted.len(), 1);
        assert!(s.is_trusted(&[0xcd; 32]));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_phones_are_dropped_on_load() {
        let dir = temp_dir("settings-phones");
        let good = format!(
            r#"{{"id":"{}","key":"{}","name":"ok","created":1}}"#,
            "a1".repeat(16),
            "b2".repeat(32)
        );
        let json = format!(
            r#"{{"device_name":"X","save_dir":{},"port":53420,"phones":[
                {{"id":"short","key":"{}","name":"bad","created":1}},{good}]}}"#,
            serde_json::to_string(&dir).unwrap(),
            "b2".repeat(32)
        );
        fs::write(dir.join(FILE), json).unwrap();
        let s = Settings::load(&dir, Path::new("/d"));
        assert_eq!(s.phones.len(), 1);
        assert_eq!(s.phones[0].name, "ok");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn name_validation() {
        assert_eq!(validate_name("  Leo's Mac\n").unwrap(), "Leo's Mac");
        assert!(validate_name("").is_err());
        assert!(validate_name(&"x".repeat(64)).is_err());
        assert!(validate_port(80).is_err());
        assert!(validate_port(53420).is_ok());
    }
}
