//! Open Yon when the person logs in. Opt-in (Settings), off by default.
//!
//! Std only, no extra crate: a LaunchAgent on macOS, a value under
//! `HKCU\...\Run` on Windows (written with the system's `reg.exe`). Both live
//! in the user's own profile, need no admin rights, and are removed again when
//! the setting is turned off. The app is started with [`FLAG`] so it stays in
//! the menu bar / tray instead of opening its window.

use std::io;

/// Start hidden: menu bar / tray only.
pub const FLAG: &str = "--background";

pub fn is_enabled() -> bool {
    imp::is_enabled()
}

pub fn set(enabled: bool) -> io::Result<()> {
    imp::set(enabled)
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The LaunchAgent. `open` starts the app the way Finder does (LaunchServices),
/// `-g` keeps it from stealing focus at login.
#[cfg(any(target_os = "macos", test))]
fn launch_agent(label: &str, bundle: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n\
  <key>Label</key><string>{}</string>\n\
  <key>ProgramArguments</key>\n  <array>\n\
    <string>/usr/bin/open</string><string>-g</string><string>-a</string><string>{}</string>\n\
    <string>--args</string><string>{}</string>\n  </array>\n\
  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n",
        xml_escape(label),
        xml_escape(bundle),
        FLAG
    )
}

#[cfg(target_os = "macos")]
mod imp {
    use std::{fs, io, path::PathBuf};

    const LABEL: &str = "io.github.vactuzx-dot.yon.login";

    fn plist_path() -> io::Result<PathBuf> {
        let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("no home folder"))?;
        Ok(PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")))
    }

    /// The running Yon.app, found from the executable's path.
    fn bundle() -> io::Result<PathBuf> {
        let exe = std::env::current_exe()?;
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(|p| p.to_path_buf())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Yon isn't running from an app bundle",
                )
            })
    }

    pub fn is_enabled() -> bool {
        plist_path().is_ok_and(|p| p.is_file())
    }

    pub fn set(enabled: bool) -> io::Result<()> {
        let path = plist_path()?;
        if !enabled {
            return match fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        }
        let bundle = bundle()?;
        let text = super::launch_agent(LABEL, &bundle.to_string_lossy());
        fs::create_dir_all(path.parent().expect("has a parent"))?;
        // WHY: write beside, then rename: a crash never leaves half a plist.
        let tmp = path.with_extension("plist.tmp");
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &path)
    }
}

#[cfg(windows)]
mod imp {
    use std::{io, os::windows::process::CommandExt, path::PathBuf, process::Command};

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "Yon";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // WHY: the system's own reg.exe by full path, never whatever PATH finds first.
    fn reg() -> Command {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let mut c = Command::new(PathBuf::from(root).join(r"System32\reg.exe"));
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }

    fn run(mut c: Command) -> io::Result<bool> {
        Ok(c.output()?.status.success())
    }

    pub fn is_enabled() -> bool {
        is_enabled_as(NAME)
    }

    pub fn set(enabled: bool) -> io::Result<()> {
        set_as(NAME, enabled)
    }

    pub(super) fn is_enabled_as(name: &str) -> bool {
        let mut c = reg();
        c.args(["query", KEY, "/v", name]);
        run(c).unwrap_or(false)
    }

    #[cfg(test)]
    pub(super) fn value_as(name: &str) -> Option<String> {
        let mut c = reg();
        c.args(["query", KEY, "/v", name]);
        let out = c.output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub(super) fn set_as(name: &str, enabled: bool) -> io::Result<()> {
        let mut c = reg();
        if enabled {
            let exe = std::env::current_exe()?;
            let cmd = format!("\"{}\" {}", exe.display(), super::FLAG);
            c.args(["add", KEY, "/v", name, "/t", "REG_SZ", "/d", &cmd, "/f"]);
        } else if is_enabled_as(name) {
            c.args(["delete", KEY, "/v", name, "/f"]);
        } else {
            return Ok(());
        }
        if run(c)? {
            Ok(())
        } else {
            Err(io::Error::other("reg.exe failed"))
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use std::io;

    pub fn is_enabled() -> bool {
        false
    }

    pub fn set(_enabled: bool) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "not supported on this system",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_agent_runs_at_login_and_starts_hidden() {
        let p = launch_agent("io.example.login", "/Applications/Yon.app");
        assert!(p.contains("<key>RunAtLoad</key><true/>"));
        assert!(p.contains("<string>/Applications/Yon.app</string>"));
        assert!(p.contains(&format!("<string>{FLAG}</string>")));
        assert!(p.contains("<string>/usr/bin/open</string>"));
    }

    #[test]
    fn launch_agent_escapes_xml_in_paths() {
        let p = launch_agent("x", "/Users/a&b/<Yon>.app");
        assert!(p.contains("/Users/a&amp;b/&lt;Yon&gt;.app"));
        assert!(!p.contains("a&b"));
    }

    // macOS itself must accept the file (plutil ships with the system).
    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_is_a_valid_plist() {
        let dir = std::env::temp_dir().join(format!("yon-plist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.plist");
        std::fs::write(
            &file,
            launch_agent("io.example.login", "/Users/a&b/Yon.app"),
        )
        .unwrap();
        let ok = std::process::Command::new("/usr/bin/plutil")
            .arg("-lint")
            .arg(&file)
            .status()
            .unwrap()
            .success();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(ok, "plutil rejected the LaunchAgent");
    }

    // The real registry round trip, under a name no real install uses.
    #[cfg(windows)]
    #[test]
    fn run_key_round_trip() {
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = imp::set_as("YonTest", false);
            }
        }
        let _c = Cleanup;
        assert!(!imp::is_enabled_as("YonTest"));
        imp::set_as("YonTest", true).unwrap();
        assert!(imp::is_enabled_as("YonTest"));
        let shown = imp::value_as("YonTest").unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(
            shown.contains(&format!("\"{}\" {}", exe.display(), FLAG)),
            "{shown}"
        );
        imp::set_as("YonTest", false).unwrap();
        assert!(!imp::is_enabled_as("YonTest"));
        imp::set_as("YonTest", false).unwrap(); // already gone: fine
    }
}
