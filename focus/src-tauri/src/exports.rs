//! Saving exports on desktop: a safe file name in the Downloads folder, never overwriting.

use std::path::{Path, PathBuf};

/// Keep letters, digits, dot, dash and underscore; never a path.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let trimmed = cleaned.trim_start_matches('.').chars().take(120).collect::<String>();
    if trimmed.is_empty() { "focus-export".into() } else { trimmed }
}

/// `name.ext`, or `name (1).ext`, `name (2).ext`… if it already exists.
pub fn unique_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = safe_name(name);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    for n in 0..1000 {
        let candidate = if n == 0 { dir.join(&name) } else { dir.join(format!("{stem} ({n}){ext}")) };
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("too many files with this name".into())
}

/// Standard base64 (RFC 4648) decoding without padding requirements.
pub fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &c in s.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        buf = (buf << 6) | val(c).ok_or("invalid base64")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name(""), "focus-export");
        let dir = tempfile::tempdir().unwrap();
        let a = unique_path(dir.path(), "focus.csv").unwrap();
        std::fs::write(&a, b"x").unwrap();
        assert_eq!(unique_path(dir.path(), "focus.csv").unwrap().file_name().unwrap(), "focus (1).csv");
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(decode_base64("Rm9jdXM=").unwrap(), b"Focus");
        assert_eq!(decode_base64("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        assert!(decode_base64("@@").is_err());
    }
}
