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
        }
    }

    /// Load from `data_dir`; missing or corrupt file → defaults.
    pub fn load(data_dir: &Path, downloads: &Path) -> Self {
        let defaults = Self::defaults(downloads);
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
    pub fn save(&self, data_dir: &Path) -> io::Result<()> {
        fs::create_dir_all(data_dir)?;
        let tmp = data_dir.join(format!("{FILE}.tmp"));
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(self).map_err(io::Error::other)?,
        )?;
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

pub fn validate_port(port: u16) -> Result<u16, &'static str> {
    if port < 1024 {
        return Err("Port must be between 1024 and 65535");
    }
    Ok(port)
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
            phones: vec![PairedPhone {
                id: "ab".repeat(16),
                key: "cd".repeat(32),
                name: "iPhone".into(),
                created: 1,
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
