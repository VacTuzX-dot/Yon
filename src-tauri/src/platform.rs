//! OS-specific bits kept behind `#[cfg]` so the core stays portable
//! (mobile targets included).

use std::io;
use std::path::Path;

pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "ios" => "ios",
        "android" => "android",
        _ => "linux",
    }
}

/// Default device name: hostname without macOS's `.local` suffix.
pub fn default_device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let name = host.trim().trim_end_matches(".local");
    let name = truncate_utf8(name, crate::protocol::MAX_DEVICE_NAME_BYTES);
    if name.is_empty() {
        "Yon device".to_string()
    } else {
        name.to_string()
    }
}

pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// Bytes available to this user on the volume holding `dir`.
#[cfg(unix)]
pub fn free_space(dir: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let mut st = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is a valid NUL-terminated path; `st` is only read after
    // statvfs reports success, which means it was fully initialized.
    let rc = unsafe { libc::statvfs(c.as_ptr(), st.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    let st = unsafe { st.assume_init() };
    // WHY: field widths differ per OS (u32 on macOS, u64 on Linux).
    #[allow(clippy::unnecessary_cast)]
    Ok(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(windows)]
pub fn free_space(dir: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail: u64 = 0;
    // SAFETY: `wide` is NUL-terminated UTF-16; out-pointers are valid or null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut avail,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(avail)
}

/// Tag a received file as coming from another machine so the OS applies
/// Gatekeeper / SmartScreen / Protected View when it is opened.
///
/// macOS: nothing to do here — `LSFileQuarantineEnabled` in Info.plist makes
/// the OS quarantine every file this app creates.
#[cfg(windows)]
pub fn mark_downloaded(path: &Path) {
    let mut ads = path.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    // ZoneId=3 (Internet) = same treatment as a browser download.
    // Filesystems without ADS (FAT/exFAT) fail here; the transfer still counts.
    if let Err(e) = std::fs::write(&ads, "[ZoneTransfer]\r\nZoneId=3\r\n") {
        eprintln!("[yon] could not write Zone.Identifier: {e}");
    }
}

#[cfg(not(windows))]
pub fn mark_downloaded(_path: &Path) {}

/// macOS: lift the quarantine from the app bundle this process runs from.
///
/// WHY: `LSFileQuarantineEnabled` quarantines every file Yon creates, and the
/// in-app updater unpacks the new app inside this process — so the relaunched
/// app was refused as "damaged". The update was already verified against the
/// minisign key pinned in this build, so only our own bundle is released;
/// received files stay quarantined.
#[cfg(target_os = "macos")]
pub fn unquarantine_own_bundle() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let app = bundle_of(&exe).ok_or_else(|| io::Error::other("not running from an .app bundle"))?;
    clear_quarantine(app)
}

/// `.../Yon.app/Contents/MacOS/yon` -> `.../Yon.app`
#[cfg(target_os = "macos")]
fn bundle_of(exe: &Path) -> Option<&Path> {
    exe.ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
}

#[cfg(target_os = "macos")]
fn clear_quarantine(path: &Path) -> io::Result<()> {
    // Exit 0 even when some files never had the attribute.
    let status = std::process::Command::new("/usr/bin/xattr")
        .args(["-d", "-r", "com.apple.quarantine"])
        .arg(path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("xattr failed: {status}")))
    }
}

/// Show `path` selected in Finder / Explorer. `path` must come from Rust
/// state (a file we saved), never from the frontend.
pub fn reveal(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()?;
    }
    #[cfg(windows)]
    {
        // WHY: the Shell API (what browsers use for "Show in folder") lets a
        // replacement file manager (Directory Opus, Files…) handle it; running
        // explorer.exe directly would always open Explorer. It may block, so
        // it runs on its own COM thread.
        let path = path.to_path_buf();
        std::thread::spawn(move || {
            if !shell_reveal(&path) {
                let _ = explorer_select(&path);
            }
        });
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn()?;
    }
    Ok(())
}

#[cfg(windows)]
fn shell_reveal(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: COM is initialized for this thread only and balanced below;
    // `wide` is NUL-terminated; the PIDL is freed exactly once.
    unsafe {
        let init = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let pidl = ILCreateFromPathW(wide.as_ptr());
        let ok = !pidl.is_null() && SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) >= 0;
        if !pidl.is_null() {
            ILFree(pidl);
        }
        if init >= 0 {
            CoUninitialize();
        }
        ok
    }
}

/// Fallback when the Shell API fails: plain Explorer.
#[cfg(windows)]
fn explorer_select(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    // WHY: explorer needs `/select,"path"` verbatim; Rust's default arg
    // quoting wraps the whole thing and explorer misparses it. Windows
    // file names cannot contain `"`, so this can't break out.
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_space_of_temp_dir() {
        assert!(free_space(&std::env::temp_dir()).unwrap() > 0);
        assert!(free_space(Path::new("/definitely/not/here")).is_err());
    }

    #[test]
    fn device_name_is_bounded() {
        let n = default_device_name();
        assert!(!n.is_empty() && n.len() <= 63);
        assert!(!n.ends_with(".local"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundle_of_needs_an_app_bundle() {
        let exe = Path::new("/Applications/Yon.app/Contents/MacOS/yon");
        assert_eq!(bundle_of(exe), Some(Path::new("/Applications/Yon.app")));
        assert_eq!(bundle_of(Path::new("/usr/local/bin/yon")), None);
        assert_eq!(bundle_of(Path::new("target/debug/yon")), None);
    }

    // Regression: the updated app kept the quarantine Yon puts on every file
    // it writes, and macOS refused to open it ("damaged").
    #[cfg(target_os = "macos")]
    #[test]
    fn clear_quarantine_removes_only_quarantine() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("yon-q-{}", std::process::id()));
        let file = dir.join("Contents/MacOS/yon");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"x").unwrap();
        let set = |name: &str| {
            let ok = Command::new("/usr/bin/xattr")
                .args(["-w", name, "0081;0;Yon;"])
                .arg(&file)
                .status()
                .unwrap()
                .success();
            assert!(ok);
        };
        set("com.apple.quarantine");
        set("io.github.vactuzx-dot.yon.test");
        let names = || {
            let out = Command::new("/usr/bin/xattr").arg(&file).output().unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        assert!(names().contains("com.apple.quarantine"));

        clear_quarantine(&dir).unwrap();

        assert!(!names().contains("com.apple.quarantine"));
        assert!(names().contains("io.github.vactuzx-dot.yon.test"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(clear_quarantine(&dir).is_err());
    }

    #[test]
    fn truncate_respects_char_boundary() {
        assert_eq!(truncate_utf8("กขค", 4), "ก");
        assert_eq!(truncate_utf8("abc", 10), "abc");
    }
}
