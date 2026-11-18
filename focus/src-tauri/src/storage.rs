//! Durable file storage for the SQLite database image and attachments (ADR-003).
//!
//! Database writes are atomic: write `focus.sqlite.tmp`, fsync, move the current
//! file to `focus.prev.sqlite`, then rename the temp file into place. A crash at
//! any point leaves either the old or the new database intact, never a torn file.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "focus.sqlite";
pub const PREV_FILE: &str = "focus.prev.sqlite";
const TMP_FILE: &str = "focus.sqlite.tmp";

pub struct Storage {
    root: PathBuf,
}

/// Names that come from the web layer are validated so they can never escape the data folder.
fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 120
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        && !name.contains("..");
    if ok { Ok(name) } else { Err(format!("invalid storage name: {name:?}")) }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp-write");
    {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

impl Storage {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("attachments")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("snapshots")).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn read_opt(path: &Path) -> Result<Option<Vec<u8>>, String> {
        match fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn load(&self) -> Result<Option<Vec<u8>>, String> {
        Self::read_opt(&self.root.join(DB_FILE))
    }

    pub fn load_previous(&self) -> Result<Option<Vec<u8>>, String> {
        Self::read_opt(&self.root.join(PREV_FILE))
    }

    pub fn save(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() < 100 || &bytes[..16] != b"SQLite format 3\0" {
            return Err("refusing to save: not a SQLite database image".into());
        }
        let tmp = self.root.join(TMP_FILE);
        {
            let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        let current = self.root.join(DB_FILE);
        if current.exists() {
            fs::rename(&current, self.root.join(PREV_FILE)).map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &current).map_err(|e| e.to_string())
    }

    pub fn save_snapshot(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let name = safe_name(name)?.replace(':', "-");
        write_atomic(&self.root.join("snapshots").join(format!("{name}.sqlite")), bytes)
    }

    pub fn file_put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        write_atomic(&self.root.join("attachments").join(safe_name(key)?), bytes)
    }

    pub fn file_get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        Self::read_opt(&self.root.join("attachments").join(safe_name(key)?))
    }

    pub fn file_delete(&self, key: &str) -> Result<(), String> {
        match fs::remove_file(self.root.join("attachments").join(safe_name(key)?)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    pub fn file_keys(&self) -> Result<Vec<String>, String> {
        let mut out = vec![];
        for entry in fs::read_dir(self.root.join("attachments")).map_err(|e| e.to_string())? {
            let name = entry.map_err(|e| e.to_string())?.file_name().to_string_lossy().to_string();
            if !name.ends_with(".tmp-write") {
                out.push(name);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(n: u8) -> Vec<u8> {
        let mut v = b"SQLite format 3\0".to_vec();
        v.resize(200, n);
        v
    }

    #[test]
    fn save_load_and_rotate() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(s.load().unwrap(), None);
        s.save(&db(1)).unwrap();
        s.save(&db(2)).unwrap();
        assert_eq!(s.load().unwrap(), Some(db(2)));
        assert_eq!(s.load_previous().unwrap(), Some(db(1)));
        assert!(!dir.path().join(TMP_FILE).exists());
    }

    #[test]
    fn refuses_non_sqlite_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::new(dir.path().to_path_buf()).unwrap();
        s.save(&db(1)).unwrap();
        assert!(s.save(b"garbage").is_err());
        assert_eq!(s.load().unwrap(), Some(db(1)));
    }

    #[test]
    fn attachments_round_trip_and_reject_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::new(dir.path().to_path_buf()).unwrap();
        s.file_put("att_123", b"hello").unwrap();
        assert_eq!(s.file_get("att_123").unwrap(), Some(b"hello".to_vec()));
        assert_eq!(s.file_keys().unwrap(), vec!["att_123".to_string()]);
        s.file_delete("att_123").unwrap();
        s.file_delete("att_123").unwrap(); // idempotent
        assert!(s.file_put("../escape", b"x").is_err());
        assert!(s.file_get("a/b").is_err());
        assert!(s.save_snapshot("pre-migration-v1", &db(3)).is_ok());
        assert!(s.save_snapshot("../../x", &db(3)).is_err());
    }
}
