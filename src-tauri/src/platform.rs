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
        use std::os::windows::process::CommandExt;
        // WHY: explorer needs `/select,"path"` verbatim; Rust's default arg
        // quoting wraps the whole thing and explorer misparses it. Windows
        // file names cannot contain `"`, so this can't break out.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn()?;
    }
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

    #[test]
    fn truncate_respects_char_boundary() {
        assert_eq!(truncate_utf8("กขค", 4), "ก");
        assert_eq!(truncate_utf8("abc", 10), "abc");
    }
}
