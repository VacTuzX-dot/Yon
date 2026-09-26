//! Receiver-side file name sanitizer. The receiver is authoritative: whatever
//! the sender claims, only the output of [`sanitize_file_name`] touches disk.
//!
//! Collisions (existing files or duplicate names within one request) are not
//! handled here — `transfer` reserves unique names with `create_new`.

const MAX_NAME_BYTES: usize = 200;
const MAX_EXT_BYTES: usize = 32;
const FALLBACK_NAME: &str = "file";

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turn an untrusted file name into one that is safe to create inside the
/// save directory on macOS, Windows and Linux alike.
pub fn sanitize_file_name(raw: &str) -> String {
    // 1. Only the last path component, whichever separator the sender used.
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");

    // 2. Characters Windows forbids, plus control characters.
    let mut name: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();

    // 3. Windows silently drops trailing dots/spaces, which would let
    //    "a.txt." collide with "a.txt" behind our no-overwrite check.
    trim_trailing(&mut name);

    // 5. Length limit (before reserved check so the prefix can't push it over
    //    by more than one byte — we budget for it below).
    name = truncate(&name, MAX_NAME_BYTES - 1);
    trim_trailing(&mut name);

    // 6. Nothing usable left ("", ".", "..").
    if name.is_empty() {
        return FALLBACK_NAME.to_string();
    }

    // 4. Windows reserved device names, applied on every OS so the result
    //    doesn't depend on who receives.
    if is_reserved(&name) {
        name.insert(0, '_');
    }

    // 8. Leading dot (".env") is intentionally kept.
    name
}

fn trim_trailing(name: &mut String) {
    let keep = name.trim_end_matches(['.', ' ']).len();
    name.truncate(keep);
}

fn is_reserved(name: &str) -> bool {
    // "CON", "con.txt", "COM1.tar.gz", "NUL .txt" are all device names.
    let stem = name.split('.').next().unwrap_or("").trim_end();
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

/// Truncate to at most `max` bytes on a char boundary, keeping a short
/// extension intact when there is one.
fn truncate(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let ext = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= MAX_EXT_BYTES => &name[i..],
        _ => "",
    };
    let stem = &name[..name.len() - ext.len()];
    let mut cut = max - ext.len();
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &stem[..cut], ext)
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name as s;

    #[test]
    fn keeps_normal_names() {
        assert_eq!(s("report.pdf"), "report.pdf");
        assert_eq!(s("รูปภาพ 2026.jpg"), "รูปภาพ 2026.jpg");
    }

    #[test]
    fn rule1_strips_any_path() {
        assert_eq!(s("../../etc/passwd"), "passwd");
        assert_eq!(s("..\\..\\Windows\\win.ini"), "win.ini");
        assert_eq!(s("/abs/path/x.txt"), "x.txt");
        assert_eq!(s("C:\\Users\\a\\x.txt"), "x.txt");
        assert_eq!(s("dir/"), "file");
    }

    #[test]
    fn rule2_replaces_forbidden_and_control_chars() {
        assert_eq!(s("report.pdf:evil.exe"), "report.pdf_evil.exe"); // NTFS ADS
        assert_eq!(s("a<b>c\"d|e?f*g"), "a_b_c_d_e_f_g");
        assert_eq!(s("nul\0byte\n.txt"), "nul_byte_.txt");
        assert_eq!(s("C:x"), "C_x");
    }

    #[test]
    fn rule3_trims_trailing_dots_and_spaces() {
        assert_eq!(s("a.txt."), "a.txt");
        assert_eq!(s("a.txt . . "), "a.txt");
    }

    #[test]
    fn rule4_prefixes_reserved_names_case_insensitive() {
        assert_eq!(s("CON"), "_CON");
        assert_eq!(s("con.txt"), "_con.txt");
        assert_eq!(s("Com1.tar.gz"), "_Com1.tar.gz");
        assert_eq!(s("lpt9"), "_lpt9");
        assert_eq!(s("NUL .txt"), "_NUL .txt");
        assert_eq!(s("CONSOLE.txt"), "CONSOLE.txt");
        assert_eq!(s("COM10"), "COM10");
    }

    #[test]
    fn rule5_truncates_to_200_bytes_keeping_extension() {
        let long = format!("{}.pdf", "a".repeat(500));
        let out = s(&long);
        assert!(out.len() <= 200, "{}", out.len());
        assert!(out.ends_with(".pdf"));

        // Multi-byte chars must not be split.
        let thai = format!("{}.txt", "ก".repeat(300));
        let out = s(&thai);
        assert!(out.len() <= 200);
        assert!(out.ends_with(".txt"));

        // Reserved prefix still fits.
        let reserved = format!("CON.{}", "x".repeat(300));
        assert!(s(&reserved).len() <= 200);
    }

    #[test]
    fn rule6_falls_back_when_empty() {
        assert_eq!(s(""), "file");
        assert_eq!(s("."), "file");
        assert_eq!(s(".."), "file");
        assert_eq!(s("..."), "file");
        assert_eq!(s("a/.."), "file");
        assert_eq!(s("   "), "file");
    }

    #[test]
    fn rule8_keeps_leading_dot() {
        assert_eq!(s(".env"), ".env");
        assert_eq!(s(".gitignore"), ".gitignore");
    }

    #[test]
    fn output_never_contains_separators_or_is_dot_dot() {
        for raw in [
            "../x",
            "..\\x",
            "x/..",
            "./.",
            "\\\\server\\share\\f",
            "a/b\\c",
        ] {
            let out = s(raw);
            assert!(!out.contains('/') && !out.contains('\\'), "{raw} -> {out}");
            assert!(out != "." && out != "..", "{raw} -> {out}");
        }
    }
}
