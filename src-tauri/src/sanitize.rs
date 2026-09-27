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

    // 2. Characters Windows forbids, plus control characters. Invisible
    //    format characters (bidi overrides etc.) are dropped so the name the
    //    user approves looks exactly like the one written to disk.
    let mut name: String = base
        .chars()
        .filter(|c| !is_hidden_format(*c))
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

/// Characters that change how text *looks* without being visible: bidi
/// controls can make `invoice\u{202E}fdp.exe` render as "invoiceexe.pdf".
/// ZWJ/ZWNJ (U+200C/D) are kept — emoji sequences and several scripts need
/// them, and they can't reorder text.
pub fn is_hidden_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}'                      // soft hyphen
        | '\u{061C}'                    // Arabic letter mark
        | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}' // Hangul fillers (blank "letters")
        | '\u{180E}'                    // Mongolian vowel separator
        | '\u{200B}'                    // zero-width space
        | '\u{200E}' | '\u{200F}'        // LRM / RLM
        | '\u{202A}'..='\u{202E}'        // embeddings / overrides
        | '\u{2060}'..='\u{2064}'        // word joiner, invisible operators
        | '\u{2066}'..='\u{206F}'        // isolates + deprecated format chars
        | '\u{FEFF}'                    // BOM / zero-width no-break space
        | '\u{FFF9}'..='\u{FFFB}'        // interlinear annotation
        | '\u{1D173}'..='\u{1D17A}'      // musical format chars
        | '\u{E0000}'..='\u{E007F}'      // tag characters (can smuggle hidden text)
    )
}

/// Clean untrusted text for display (device / sender names): no control
/// or invisible format characters, trimmed, at most `max` bytes.
pub fn clean_display(s: &str, max: usize) -> String {
    let s: String = s
        .chars()
        .filter(|c| !c.is_control() && !is_hidden_format(*c))
        .collect();
    crate::platform::truncate_utf8(s.trim(), max)
        .trim_end()
        .to_string()
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

    #[test]
    fn strips_bidi_and_invisible_characters() {
        // Right-to-left override: would display as "invoiceexe.pdf".
        assert_eq!(s("invoice\u{202E}fdp.exe"), "invoicefdp.exe");
        assert_eq!(s("a\u{2066}b\u{2069}c\u{200B}d\u{FEFF}.txt"), "abcd.txt");
        assert_eq!(s("\u{202E}\u{200B}"), "file");
        assert_eq!(s("x\u{E0041}\u{E0042}.png"), "x.png");
    }

    #[test]
    fn keeps_joiners_needed_by_emoji_and_scripts() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.png";
        assert_eq!(s(family), family);
        assert_eq!(
            s("\u{0645}\u{200C}\u{0627}.txt"),
            "\u{0645}\u{200C}\u{0627}.txt"
        );
    }

    #[test]
    fn clean_display_names() {
        use super::clean_display as c;
        assert_eq!(c("Leo\u{200B}'s\u{202E} Mac\n", 63), "Leo's Mac");
        assert_eq!(c("\u{3164}\u{3164}", 63), "");
        assert_eq!(c("  กขค  ", 4), "ก");
    }
}
