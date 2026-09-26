//! User settings persisted as JSON in the app data dir.

use crate::protocol::MAX_DEVICE_NAME_BYTES;
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
}

impl Settings {
    pub fn defaults(downloads: &Path) -> Self {
        Self {
            device_name: crate::platform::default_device_name(),
            save_dir: downloads.join("Yon"),
            port: crate::server::DEFAULT_PORT,
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
                s
            }
            Err(e) => {
                eprintln!("[yon] settings.json unreadable, using defaults: {e}");
                defaults
            }
        }
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
    let name: String = raw.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim();
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
    fn name_validation() {
        assert_eq!(validate_name("  Leo's Mac\n").unwrap(), "Leo's Mac");
        assert!(validate_name("").is_err());
        assert!(validate_name(&"x".repeat(64)).is_err());
        assert!(validate_port(80).is_err());
        assert!(validate_port(53420).is_ok());
    }
}
