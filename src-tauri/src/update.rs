//! In-app updates from GitHub Releases via tauri-plugin-updater.
//!
//! Every download is checked against the minisign public key built into the
//! app (`plugins.updater.pubkey`) before it is installed, so a tampered
//! release asset or a hijacked download can't replace Yon.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct UpdateDto {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct UpdateProgressDto {
    pub done: u64,
    pub total: Option<u64>,
}

/// Remove what earlier updates left in the temp folder. On Windows the
/// updater writes the new installer to `<temp>/<App>-<version>-updater-*/`
/// and quits the app to run it, so nothing ever deletes that folder.
/// Returns how many folders were removed. Only exact matches are touched.
pub fn sweep_leftovers(temp: &Path, app_name: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return 0;
    };
    let prefix = format!("{app_name}-");
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.strip_prefix(&prefix).is_some_and(|rest| {
                // "<version>-updater-<random>", version starts with a digit.
                rest.starts_with(|c: char| c.is_ascii_digit()) && rest.contains("-updater-")
            })
        })
        // Best effort: a folder still in use (installer running) stays for
        // the next launch.
        .filter(|e| std::fs::remove_dir_all(e.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::sweep_leftovers;
    use std::fs;

    #[test]
    fn removes_only_our_updater_folders() {
        let root = std::env::temp_dir().join(format!("yon-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in [
            "Yon-0.2.0-updater-abc123",
            "Yon-0.1.9-updater-x",
            "Yon-data",
            "Yon-updater-x",
            "Other-0.2.0-updater-x",
            "yon-0.2.0-updater-x",
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(
            root.join("Yon-0.2.0-updater-abc123/Yon-0.2.0-installer.exe"),
            b"x",
        )
        .unwrap();
        fs::write(root.join("Yon-0.3.0-updater-file"), b"not a dir").unwrap();

        assert_eq!(sweep_leftovers(&root, "Yon"), 2);
        let mut left: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "Other-0.2.0-updater-x",
                "Yon-0.3.0-updater-file",
                "Yon-data",
                "Yon-updater-x",
                "yon-0.2.0-updater-x"
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
