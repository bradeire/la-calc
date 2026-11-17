//! Background sync (Android, while Focus is closed): a Rust port of the sync engine in
//! `src/services/sync-service.ts`. Same keys, envelope, item format and merge rules; the
//! shared test vectors in `tests/fixtures` (made by the TypeScript engine) keep them identical.
//!
//! It works on a copy of the database file and replaces the original atomically at the end,
//! so a crash midway leaves the user's data untouched. It pulls, applies, pushes and pulls
//! again; compaction and attachment files are left to the app in the foreground.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hkdf::Hkdf;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value as J};
use sha2::Sha256;

// ---------- tables (keep in step with src/core/sync/tables.ts) ----------

pub struct Table {
    pub name: &'static str,
    pub key: &'static [&'static str],
}

pub const TABLES: &[Table] = &[
    Table { name: "settings", key: &["key"] },
    Table { name: "projects", key: &["id"] },
    Table { name: "sections", key: &["id"] },
    Table { name: "labels", key: &["id"] },
    Table { name: "tasks", key: &["id"] },
    Table { name: "recurrence_rules", key: &["id"] },
    Table { name: "task_labels", key: &["task_id", "label_id"] },
    Table { name: "task_dependencies", key: &["task_id", "depends_on_id"] },
    Table { name: "reminders", key: &["id"] },
    Table { name: "comments", key: &["id"] },
    Table { name: "attachments", key: &["id"] },
    Table { name: "time_entries", key: &["id"] },
    Table { name: "activity_log", key: &["id"] },
    Table { name: "project_templates", key: &["id"] },
    Table { name: "saved_filters", key: &["id"] },
    Table { name: "automations", key: &["id"] },
    Table { name: "automation_runs", key: &["id"] },
];
const SYNCED_SETTINGS: &[&str] = &["dateOrder", "hour12", "weekStartsOn", "workingHours", "defaultEstimate", "autoCompleteParent", "showCompletedInProjects", "goals"];
const SEP: char = '\u{1f}';
const MAX_BATCH_JSON: usize = 700_000;
const PAGE: u32 = 100;

fn table(name: &str) -> Option<&'static Table> {
    TABLES.iter().find(|t| t.name == name)
}

// ---------- keys and envelope (src/core/sync/crypto.ts) ----------

const CROCKFORD: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn parse_sync_key(s: &str) -> Result<Vec<u8>, String> {
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = Vec::new();
    for ch in s.to_uppercase().chars() {
        let ch = match ch {
            '-' | ' ' | '\t' | '\n' => continue,
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        };
        let v = CROCKFORD.find(ch).ok_or_else(|| format!("“{ch}” isn’t part of a sync key"))? as u32;
        value = (value << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    if out.len() != 32 {
        return Err("That sync key is incomplete or too long".into());
    }
    Ok(out)
}

pub struct Keys {
    pub vault_id: String,
    pub token: String,
    data_key: [u8; 32],
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn derive_keys(sync_key: &str) -> Result<Keys, String> {
    let raw = parse_sync_key(sync_key)?;
    let hk = Hkdf::<Sha256>::new(Some(b"focus-sync-v1"), &raw);
    let mut vault = [0u8; 16];
    let mut token = [0u8; 32];
    let mut data_key = [0u8; 32];
    hk.expand(b"vault-id", &mut vault).map_err(|e| e.to_string())?;
    hk.expand(b"relay-auth", &mut token).map_err(|e| e.to_string())?;
    hk.expand(b"data-key", &mut data_key).map_err(|e| e.to_string())?;
    Ok(Keys { vault_id: hex(&vault), token: hex(&token), data_key })
}

fn random_iv() -> Result<[u8; 12], String> {
    let mut iv = [0u8; 12];
    getrandom(&mut iv)?;
    Ok(iv)
}

/// OS randomness via the AES-GCM crate's re-export of `rand_core`'s OsRng.
fn getrandom(buf: &mut [u8]) -> Result<(), String> {
    use aes_gcm::aead::rand_core::RngCore;
    aes_gcm::aead::OsRng.try_fill_bytes(buf).map_err(|e| e.to_string())
}

pub fn seal_json(keys: &Keys, value: &J) -> Result<String, String> {
    let plain = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&plain).map_err(|e| e.to_string())?;
    let zipped = gz.finish().map_err(|e| e.to_string())?;
    let (flag, body) = if zipped.len() < plain.len() { (1u8, zipped) } else { (0u8, plain) };
    let iv = random_iv()?;
    let cipher = Aes256Gcm::new_from_slice(&keys.data_key).map_err(|e| e.to_string())?;
    let ct = cipher.encrypt(Nonce::from_slice(&iv), Payload { msg: &body, aad: keys.vault_id.as_bytes() }).map_err(|_| "encryption failed".to_string())?;
    let mut out = vec![1u8, flag];
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

pub fn open_json(keys: &Keys, data: &str) -> Result<J, String> {
    let bytes = B64.decode(data).map_err(|_| "Damaged sync data".to_string())?;
    if bytes.len() < 14 || bytes[0] != 1 {
        return Err("Sync data from a newer version of Focus".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&keys.data_key).map_err(|e| e.to_string())?;
    let body = cipher
        .decrypt(Nonce::from_slice(&bytes[2..14]), Payload { msg: &bytes[14..], aad: keys.vault_id.as_bytes() })
        .map_err(|_| "Sync data couldn’t be decrypted with this key".to_string())?;
    let plain = if bytes[1] == 1 {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut out).map_err(|e| e.to_string())?;
        out
    } else {
        body
    };
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

// ---------- values ----------

fn to_sql(v: &J) -> Value {
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Integer(*b as i64),
        J::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        J::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn to_json(v: Value) -> J {
    match v {
        Value::Null => J::Null,
        Value::Integer(i) => json!(i),
        // JavaScript has one number type: 1.0 is written as 1, as the TypeScript engine does.
        Value::Real(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => json!(f as i64),
        Value::Real(f) => json!(f),
        Value::Text(s) => J::String(s),
        Value::Blob(b) => J::String(B64.encode(b)),
    }
}

/// JavaScript's String(x), used where the TypeScript engine compares stringified values.
fn js_string(v: &J) -> String {
    match v {
        J::Null => "null".into(),
        J::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn hlc(ms: i64, counter: i64, device: &str) -> String {
    format!("{:013}-{:05}-{}", ms.max(0), counter, device)
}

fn parse_hlc(v: &str) -> Option<(i64, i64)> {
    let b = v.as_bytes();
    if b.len() < 21 || b[13] != b'-' || b[19] != b'-' || !v[..13].bytes().all(|c| c.is_ascii_digit()) || !v[14..19].bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((v[..13].parse().ok()?, v[14..19].parse().ok()?))
}

/// v1 version "ISO time|device" → HLC (as fromLegacyVersion in TypeScript).
fn from_legacy(v: &str) -> String {
    let (time, device) = match v.rfind('|') {
        Some(i) => (&v[..i], &v[i + 1..]),
        None => (v, "legacy"),
    };
    let ms = parse_iso_ms(time).unwrap_or(0);
    hlc(ms, 0, device)
}

/// Minimal ISO-8601 UTC parser ("2026-11-16T10:00:00.000Z").
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?, n(17, 2)?);
    let ms = if b.len() >= 23 && b[19] == b'.' { n(20, 3)? } else { 0 };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

// ---------- engine ----------

pub struct Engine<'a> {
    pub conn: &'a Connection,
}

type Item = Map<String, J>;

impl<'a> Engine<'a> {
    pub fn meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())
    }
    pub fn set_meta(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            None => self.conn.execute("DELETE FROM sync_meta WHERE key = ?1", [key]),
            Some(v) => self.conn.execute("INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, v]),
        }
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
    fn device(&self) -> Result<String, String> {
        self.conn.query_row("SELECT device_id FROM sync_control WHERE id = 1", [], |r| r.get(0)).map_err(|e| e.to_string())
    }
    pub fn enabled(&self) -> Result<bool, String> {
        self.conn.query_row("SELECT enabled FROM sync_control WHERE id = 1", [], |r| r.get::<_, i64>(0)).map(|e| e == 1).map_err(|e| e.to_string())
    }
    fn table_cols(&self, t: &str) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare(&format!("PRAGMA table_info({t})")).map_err(|e| e.to_string())?;
        let cols = st.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(cols)
    }
    fn where_clause(t: &Table, key: &str) -> (String, Vec<Value>) {
        let parts: Vec<Value> = key.split(SEP).map(|p| Value::Text(p.to_string())).collect();
        (t.key.iter().map(|k| format!("{k} = ?")).collect::<Vec<_>>().join(" AND "), parts)
    }
    fn row(&self, tbl: &str, w: &(String, Vec<Value>)) -> Result<Option<Vec<(String, Value)>>, String> {
        let mut st = self.conn.prepare(&format!("SELECT * FROM {tbl} WHERE {}", w.0)).map_err(|e| e.to_string())?;
        let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = st.query(rusqlite::params_from_iter(w.1.iter())).map_err(|e| e.to_string())?;
        if let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let mut out = Vec::new();
            for (i, n) in names.iter().enumerate() {
                out.push((n.clone(), r.get::<_, Value>(i).map_err(|e| e.to_string())?));
            }
            Ok(Some(out))
        } else {
            Ok(None)
        }
    }

    pub fn read_item(&self, tbl: &str, key: &str) -> Result<Option<J>, String> {
        let Some(t) = table(tbl) else { return Ok(None) };
        let w = Self::where_clause(t, key);
        let row = self.row(tbl, &w)?;
        let d: Option<String> = self
            .conn
            .query_row("SELECT version FROM sync_tombstones WHERE tbl = ?1 AND row_key = ?2", params![tbl, key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(row) = row else {
            return Ok(d.map(|d| json!({ "t": tbl, "k": key, "d": d })));
        };
        let mut st = self.conn.prepare("SELECT col, version FROM sync_fields WHERE tbl = ?1 AND row_key = ?2").map_err(|e| e.to_string())?;
        let versions: HashMap<String, String> =
            st.query_map(params![tbl, key], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let floor = hlc(0, 0, &self.device()?);
        let mut f = Map::new();
        for (c, v) in row {
            let ver = versions.get(&c).cloned().unwrap_or_else(|| floor.clone());
            f.insert(c, json!([to_json(v), ver]));
        }
        let mut it = json!({ "t": tbl, "k": key, "f": f });
        if let Some(d) = d {
            it["d"] = J::String(d);
        }
        Ok(Some(it))
    }

    fn normalise(it: Item) -> Item {
        let Some(v) = it.get("v").and_then(|x| x.as_str()).map(from_legacy) else { return it };
        let mut out = Map::new();
        out.insert("t".into(), it["t"].clone());
        out.insert("k".into(), it["k"].clone());
        match it.get("r") {
            Some(J::Object(r)) => {
                let mut f = Map::new();
                for (c, x) in r {
                    f.insert(c.clone(), json!([x, v]));
                }
                out.insert("f".into(), J::Object(f));
            }
            _ => {
                out.insert("d".into(), J::String(v));
            }
        }
        out
    }

    fn waiting_items(&self) -> Result<Vec<Item>, String> {
        Ok(match self.meta("waiting")? {
            Some(raw) => serde_json::from_str::<Vec<Item>>(&raw).map_err(|e| e.to_string())?,
            None => vec![],
        })
    }

    /// Apply remote rows field by field; rows whose parent hasn't arrived wait.
    pub fn apply(&self, items: Vec<Item>) -> Result<(), String> {
        let order = |t: &str| TABLES.iter().position(|x| x.name == t).unwrap_or(usize::MAX);
        let mut sorted: Vec<Item> = items.into_iter().filter(|i| i.get("t").and_then(|t| t.as_str()).and_then(table).is_some()).map(Self::normalise).collect();
        sorted.sort_by_key(|i| order(i["t"].as_str().unwrap_or("")));
        let mut waiting: Vec<Item> = vec![];
        self.conn.execute("UPDATE sync_control SET applying = 1 WHERE id = 1", []).map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            let whole = (|| -> Result<(), String> {
                self.conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;").map_err(|e| e.to_string())?;
                for it in &sorted {
                    self.apply_one(it)?;
                }
                let bad = self.conn.prepare("PRAGMA foreign_key_check").map_err(|e| e.to_string())?.query([]).map_err(|e| e.to_string())?.next().map_err(|e| e.to_string())?.is_some();
                if bad {
                    return Err("foreign keys".into());
                }
                self.conn.execute_batch("COMMIT").map_err(|e| e.to_string())
            })();
            if whole.is_err() {
                let _ = self.conn.execute_batch("ROLLBACK");
                for it in &sorted {
                    self.conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                    match self.apply_one(it) {
                        Ok(()) => self.conn.execute_batch("COMMIT").map_err(|e| e.to_string())?,
                        Err(_) => {
                            let _ = self.conn.execute_batch("ROLLBACK");
                            waiting.push(it.clone());
                        }
                    }
                }
            }
            self.observe(&sorted)
        })();
        self.conn.execute("UPDATE sync_control SET applying = 0 WHERE id = 1", []).map_err(|e| e.to_string())?;
        result?;
        let keep = if waiting.len() > 2000 { waiting.split_off(waiting.len() - 2000) } else { waiting };
        if keep.is_empty() {
            self.set_meta("waiting", None)
        } else {
            self.set_meta("waiting", Some(&serde_json::to_string(&keep).map_err(|e| e.to_string())?))
        }
    }

    fn observe(&self, items: &[Item]) -> Result<(), String> {
        let mut best: Option<(i64, i64)> = None;
        for it in items {
            let mut vs: Vec<&str> = vec![];
            if let Some(d) = it.get("d").and_then(|d| d.as_str()) {
                vs.push(d);
            }
            if let Some(J::Object(f)) = it.get("f") {
                for x in f.values() {
                    if let Some(v) = x.get(1).and_then(|v| v.as_str()) {
                        vs.push(v);
                    }
                }
            }
            for v in vs {
                if let Some(h) = parse_hlc(v) {
                    if best.map_or(true, |b| h > b) {
                        best = Some(h);
                    }
                }
            }
        }
        let Some((ms, counter)) = best else { return Ok(()) };
        let (cm, cc): (i64, i64) = self.conn.query_row("SELECT hlc_ms, hlc_counter FROM sync_control WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        if (ms, counter) > (cm, cc) {
            self.conn.execute("UPDATE sync_control SET hlc_ms = ?1, hlc_counter = ?2 WHERE id = 1", params![ms, counter]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn apply_one(&self, it: &Item) -> Result<(), String> {
        let tbl = it["t"].as_str().unwrap_or("");
        let key = it["k"].as_str().unwrap_or("");
        let t = table(tbl).ok_or("unknown table")?;
        if tbl == "settings" && !SYNCED_SETTINGS.contains(&key) {
            return Ok(());
        }
        let w = Self::where_clause(t, key);
        let mut st = self.conn.prepare("SELECT col, version FROM sync_fields WHERE tbl = ?1 AND row_key = ?2").map_err(|e| e.to_string())?;
        let local: HashMap<String, String> =
            st.query_map(params![tbl, key], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let local_tomb: String = self
            .conn
            .query_row("SELECT version FROM sync_tombstones WHERE tbl = ?1 AND row_key = ?2", params![tbl, key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let incoming_tomb = it.get("d").and_then(|d| d.as_str()).unwrap_or("");
        let tomb = if incoming_tomb > local_tomb.as_str() { incoming_tomb.to_string() } else { local_tomb.clone() };
        let empty = Map::new();
        let incoming = it.get("f").and_then(|f| f.as_object()).unwrap_or(&empty);
        let inc_version = |c: &str| incoming.get(c).and_then(|x| x.get(1)).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let winners: Vec<String> = incoming.keys().filter(|c| inc_version(c).as_str() > local.get(*c).map(|s| s.as_str()).unwrap_or("")).cloned().collect();
        let mut newest = String::new();
        let all_cols: HashSet<&String> = local.keys().chain(incoming.keys()).collect();
        for c in all_cols {
            let l = local.get(c).cloned().unwrap_or_default();
            let i = inc_version(c);
            let v = if l > i { l } else { i };
            if v > newest {
                newest = v;
            }
        }
        let exists = !newest.is_empty() && newest > tomb;
        let row_exists = self.row(tbl, &w)?.is_some();
        let table_cols: HashSet<String> = self.table_cols(tbl)?.into_iter().collect();

        if !exists {
            if row_exists {
                self.conn.execute(&format!("DELETE FROM {tbl} WHERE {}", w.0), rusqlite::params_from_iter(w.1.iter())).map_err(|e| e.to_string())?;
            }
        } else if row_exists {
            let set: Vec<String> = winners.iter().filter(|c| table_cols.contains(*c) && !t.key.contains(&c.as_str())).cloned().collect();
            if !set.is_empty() {
                let current = self.row(tbl, &w)?.unwrap_or_default();
                let mut row: Map<String, J> = current.into_iter().map(|(c, v)| (c, to_json(v))).collect();
                for c in &set {
                    row.insert(c.clone(), incoming[c][0].clone());
                }
                if !self.resolve_unique(tbl, &mut row)? {
                    return Ok(());
                }
                let mut vals: Vec<Value> = set.iter().map(|c| to_sql(row.get(c).unwrap_or(&J::Null))).collect();
                vals.extend(w.1.iter().cloned());
                let sql = format!("UPDATE {tbl} SET {} WHERE {}", set.iter().map(|c| format!("{c} = ?")).collect::<Vec<_>>().join(", "), w.0);
                self.conn.execute(&sql, rusqlite::params_from_iter(vals.iter())).map_err(|e| e.to_string())?;
            }
        } else {
            let mut row: Map<String, J> = Map::new();
            for (c, x) in incoming {
                if table_cols.contains(c) {
                    row.insert(c.clone(), x.get(0).cloned().unwrap_or(J::Null));
                }
            }
            if !self.resolve_unique(tbl, &mut row)? {
                return Ok(());
            }
            if !t.key.iter().all(|k| row.contains_key(*k)) {
                return Ok(());
            }
            let cols: Vec<&String> = row.keys().collect();
            let sql = format!("INSERT INTO {tbl} ({}) VALUES ({})", cols.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", "), cols.iter().map(|_| "?").collect::<Vec<_>>().join(", "));
            let vals: Vec<Value> = cols.iter().map(|c| to_sql(&row[*c])).collect();
            self.conn.execute(&sql, rusqlite::params_from_iter(vals.iter())).map_err(|e| e.to_string())?;
        }
        for c in &winners {
            self.conn
                .execute(
                    "INSERT INTO sync_fields (tbl, row_key, col, version) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(tbl, row_key, col) DO UPDATE SET version = excluded.version",
                    params![tbl, key, c, inc_version(c)],
                )
                .map_err(|e| e.to_string())?;
        }
        if !tomb.is_empty() && tomb != local_tomb {
            self.conn
                .execute("INSERT INTO sync_tombstones (tbl, row_key, version) VALUES (?1, ?2, ?3) ON CONFLICT(tbl, row_key) DO UPDATE SET version = excluded.version", params![tbl, key, tomb])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Same deterministic rules as resolveUnique in TypeScript.
    fn resolve_unique(&self, tbl: &str, row: &mut Map<String, J>) -> Result<bool, String> {
        let s = |row: &Map<String, J>, c: &str| js_string(row.get(c).unwrap_or(&J::Null));
        if tbl == "labels" && row.get("deleted_at").map_or(true, |v| v.is_null()) {
            let clash: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT id, name FROM labels WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL AND id <> ?2",
                    params![s(row, "name"), s(row, "id")],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((cid, cname)) = clash {
                let rename = |name: &str, id: &str| format!("{}-{}", name.chars().take(55).collect::<String>(), id.chars().take(4).collect::<String>());
                let id = s(row, "id");
                if id > cid {
                    let n = rename(&s(row, "name"), &id);
                    row.insert("name".into(), J::String(n));
                } else {
                    self.conn.execute("UPDATE labels SET name = ?1 WHERE id = ?2", params![rename(&cname, &cid), cid]).map_err(|e| e.to_string())?;
                }
            }
        }
        if tbl == "recurrence_rules" {
            let other: Option<(String, String)> = self
                .conn
                .query_row("SELECT id, updated_at FROM recurrence_rules WHERE task_id = ?1 AND id <> ?2", params![s(row, "task_id"), s(row, "id")], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((oid, oup)) = other {
                let (up, id) = (s(row, "updated_at"), s(row, "id"));
                if !(up > oup || (up == oup && id > oid)) {
                    return Ok(false);
                }
                self.conn.execute("DELETE FROM recurrence_rules WHERE id = ?1", [oid]).map_err(|e| e.to_string())?;
            }
        }
        if tbl == "automation_runs" {
            let dup: Option<i64> = self
                .conn
                .query_row(
                    "SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND event_key = ?2 AND id <> ?3",
                    params![s(row, "automation_id"), s(row, "event_key"), s(row, "id")],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if dup.is_some() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Local changes as encrypted batches, at most MAX_BATCH_JSON each.
    pub fn outgoing(&self) -> Result<(i64, Vec<Vec<J>>), String> {
        let mut st = self.conn.prepare("SELECT tbl, row_key, MAX(seq) AS seq FROM sync_changes GROUP BY tbl, row_key ORDER BY seq LIMIT 5000").map_err(|e| e.to_string())?;
        let changes: Vec<(String, String, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let max_seq = changes.iter().map(|c| c.2).max().unwrap_or(0);
        let mut chunks: Vec<Vec<J>> = vec![];
        let mut chunk: Vec<J> = vec![];
        let mut size = 0;
        for (tbl, key, _) in &changes {
            if let Some(it) = self.read_item(tbl, key)? {
                let n = it.to_string().len();
                if size + n > MAX_BATCH_JSON && !chunk.is_empty() {
                    chunks.push(std::mem::take(&mut chunk));
                    size = 0;
                }
                chunk.push(it);
                size += n;
            }
        }
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        Ok((max_seq, chunks))
    }
}

// ---------- relay client and the sync run ----------

pub struct Relay {
    pub url: String,
    pub licence: Option<String>,
    client: reqwest::Client,
}

impl Relay {
    pub fn new(url: &str, licence: Option<String>) -> Result<Self, String> {
        let client = crate::http::client_builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
        Ok(Relay { url: url.trim_end_matches('/').to_string(), licence, client })
    }
    async fn call(&self, method: &str, path: &str, token: &str, body: Option<J>) -> Result<J, String> {
        let mut req = if method == "POST" { self.client.post(format!("{}{}", self.url, path)) } else { self.client.get(format!("{}{}", self.url, path)) };
        req = req.header("Authorization", format!("Bearer {token}"));
        if let Some(l) = &self.licence {
            req = req.header("X-Focus-Licence", l);
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json").body(b.to_string());
        }
        let res = req.send().await.map_err(|e| format!("Couldn’t reach the sync relay: {e}"))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let data: J = serde_json::from_str(&text).unwrap_or(J::Null);
        if !(200..300).contains(&status) {
            return Err(format!("Sync relay error {status}: {}", data.get("error").and_then(|e| e.as_str()).unwrap_or("")));
        }
        Ok(data)
    }
}

pub struct Report {
    pub pulled: usize,
    pub pushed: usize,
}

async fn pull(engine: &Engine<'_>, relay: &Relay, keys: &Keys) -> Result<usize, String> {
    let me = engine.device()?;
    let mut count = 0;
    for _ in 0..10_000 {
        let after: i64 = engine.meta("cursor")?.and_then(|c| c.parse().ok()).unwrap_or(0);
        let page = relay.call("GET", &format!("/v1/vaults/{}/batches?after={after}&limit={PAGE}", keys.vault_id), &keys.token, None).await?;
        if let Some(snap) = page.get("snapshot").filter(|s| !s.is_null()) {
            let up_to = snap["upTo"].as_i64().unwrap_or(0);
            if after < up_to {
                let id = snap["id"].as_str().unwrap_or("");
                let mut items: Vec<Item> = engine.waiting_items()?;
                for i in 0..snap["parts"].as_i64().unwrap_or(0) {
                    let part = relay.call("GET", &format!("/v1/vaults/{}/snapshots/{id}/parts/{i}", keys.vault_id), &keys.token, None).await?;
                    let opened = open_json(keys, part["data"].as_str().unwrap_or(""))?;
                    items.extend(opened.as_array().cloned().unwrap_or_default().into_iter().filter_map(|x| x.as_object().cloned()));
                }
                count += items.len();
                engine.apply(items)?;
                engine.set_meta("cursor", Some(&up_to.to_string()))?;
                continue;
            }
        }
        let batches = page["batches"].as_array().cloned().unwrap_or_default();
        if batches.is_empty() {
            break;
        }
        let mut items: Vec<Item> = engine.waiting_items()?;
        for b in &batches {
            if b["device"].as_str() == Some(me.as_str()) {
                continue;
            }
            let opened = open_json(keys, b["data"].as_str().unwrap_or(""))?;
            items.extend(opened.as_array().cloned().unwrap_or_default().into_iter().filter_map(|x| x.as_object().cloned()));
        }
        count += items.len();
        engine.apply(items)?;
        engine.set_meta("cursor", Some(&batches.last().unwrap()["seq"].as_i64().unwrap_or(after).to_string()))?;
        if !page["more"].as_bool().unwrap_or(false) {
            break;
        }
    }
    let waiting = engine.waiting_items()?;
    if !waiting.is_empty() {
        engine.apply(waiting)?;
    }
    Ok(count)
}

async fn push(engine: &Engine<'_>, relay: &Relay, keys: &Keys) -> Result<usize, String> {
    let me = engine.device()?;
    let mut count = 0;
    for _ in 0..1000 {
        let (max_seq, chunks) = engine.outgoing()?;
        if max_seq == 0 {
            break;
        }
        for chunk in chunks {
            count += chunk.len();
            let data = seal_json(keys, &J::Array(chunk))?;
            relay.call("POST", &format!("/v1/vaults/{}/batches", keys.vault_id), &keys.token, Some(json!({ "device": me, "data": data }))).await?;
        }
        engine.conn.execute("DELETE FROM sync_changes WHERE seq <= ?1", [max_seq]).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// One sync on an open database (already a private copy).
pub async fn sync_connection(conn: &Connection, sync_key: &str, licence: Option<String>, now_iso: &str) -> Result<Report, String> {
    let engine = Engine { conn };
    if !engine.enabled()? {
        return Ok(Report { pulled: 0, pushed: 0 });
    }
    let url = engine.meta("relayUrl")?.ok_or("No sync relay is set up")?;
    let keys = derive_keys(sync_key)?;
    let relay = Relay::new(&url, licence)?;
    let run = async {
        let pulled = pull(&engine, &relay, &keys).await?;
        let pushed = push(&engine, &relay, &keys).await?;
        pull(&engine, &relay, &keys).await?;
        Ok::<_, String>(Report { pulled, pushed })
    };
    match run.await {
        Ok(r) => {
            engine.set_meta("lastSyncAt", Some(now_iso))?;
            engine.set_meta("lastError", None)?;
            Ok(r)
        }
        Err(e) => {
            let _ = engine.set_meta("lastError", Some(&e));
            Err(e)
        }
    }
}

/// Background sync of the app's database in `root` (the app-data folder). The database is copied,
/// synced, and written back atomically through `Storage` only if `still_ok()` is true at the end
/// (on Android: the app hasn't been opened meanwhile).
pub async fn sync_storage(root: &Path, sync_key: &str, licence: Option<String>, still_ok: impl Fn() -> bool) -> Result<Report, String> {
    let storage = crate::storage::Storage::new(root.to_path_buf())?;
    let Some(bytes) = storage.load()? else { return Ok(Report { pulled: 0, pushed: 0 }) };
    let tmp = root.join("bgsync.tmp.sqlite");
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let report = {
        let conn = Connection::open(&tmp).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF; PRAGMA journal_mode = DELETE;").map_err(|e| e.to_string())?;
        let now = now_iso();
        let r = sync_connection(&conn, sync_key, licence, &now).await;
        drop(conn);
        r
    };
    let result = match report {
        Ok(r) => {
            if still_ok() {
                let synced = std::fs::read(&tmp).map_err(|e| e.to_string())?;
                storage.save(&synced)?;
            }
            Ok(r)
        }
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&tmp);
    result
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Civil from days (Howard Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// Whether the Focus window is open (Android: set by MainActivity through JNI).
pub static APP_ALIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "android")]
mod android_jni {
    use jni::objects::{JClass, JString};
    use jni::sys::{jboolean, jstring};
    use jni::JNIEnv;
    use std::sync::atomic::Ordering;

    fn read(env: &mut JNIEnv, s: &JString) -> String {
        if s.is_null() {
            return String::new();
        }
        env.get_string(s).map(|x| x.into()).unwrap_or_default()
    }

    #[no_mangle]
    pub extern "system" fn Java_uk_periopdigital_focus_FocusNative_setAppAlive(_env: JNIEnv, _class: JClass, alive: jboolean) {
        super::APP_ALIVE.store(alive != 0, Ordering::SeqCst);
    }

    #[no_mangle]
    pub extern "system" fn Java_uk_periopdigital_focus_FocusNative_runSync<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>, root: JString<'l>, key: JString<'l>, licence: JString<'l>) -> jstring {
        let root = read(&mut env, &root);
        let key = read(&mut env, &key);
        let licence = read(&mut env, &licence);
        let report = if super::APP_ALIVE.load(Ordering::SeqCst) {
            serde_json::json!({ "ok": true, "skipped": "app is open" })
        } else {
            let result = tauri::async_runtime::block_on(super::sync_storage(
                std::path::Path::new(&root),
                &key,
                if licence.is_empty() { None } else { Some(licence) },
                || !super::APP_ALIVE.load(Ordering::SeqCst),
            ));
            match result {
                Ok(r) => serde_json::json!({ "ok": true, "pulled": r.pulled, "pushed": r.pushed }),
                Err(e) => serde_json::json!({ "ok": false, "error": e }),
            }
        };
        env.new_string(report.to_string()).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }
    fn vectors() -> J {
        serde_json::from_slice(&std::fs::read(fixtures().join("vectors.json")).unwrap()).unwrap()
    }

    #[test]
    fn keys_and_envelope_match_typescript() {
        let v = vectors();
        let keys = derive_keys(v["key"].as_str().unwrap()).unwrap();
        assert_eq!(keys.vault_id, v["vaultId"].as_str().unwrap());
        assert_eq!(keys.token, v["token"].as_str().unwrap());
        assert_eq!(open_json(&keys, v["sealed"].as_str().unwrap()).unwrap(), v["sealedItems"]);
        let sealed = seal_json(&keys, &v["sealedItems"]).unwrap();
        assert_eq!(open_json(&keys, &sealed).unwrap(), v["sealedItems"]);
        if std::env::var("GENERATE_SYNC_VECTORS").is_ok() {
            std::fs::write(fixtures().join("rust-sealed.json"), json!({ "sealed": sealed, "items": v["sealedItems"] }).to_string()).unwrap();
        }
        let wrong = derive_keys("0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000").unwrap();
        assert!(open_json(&wrong, v["sealed"].as_str().unwrap()).is_err());
    }

    fn dump(conn: &Connection) -> J {
        let mut out = Map::new();
        for t in ["projects", "sections", "labels", "tasks", "recurrence_rules", "task_labels", "task_dependencies", "comments", "settings", "sync_fields", "sync_tombstones"] {
            let mut st = conn.prepare(&format!("SELECT * FROM {t}")).unwrap();
            let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
            let mut rows: Vec<String> = st
                .query_map([], |r| {
                    let mut m = std::collections::BTreeMap::new();
                    for (i, n) in names.iter().enumerate() {
                        m.insert(n.clone(), to_json(r.get::<_, Value>(i)?));
                    }
                    Ok(serde_json::to_string(&m).unwrap())
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows.sort();
            out.insert(t.into(), json!(rows));
        }
        let (ms, c): (i64, i64) = conn.query_row("SELECT hlc_ms, hlc_counter FROM sync_control", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        out.insert("clock".into(), json!([ms, c]));
        let waiting: Option<String> = conn.query_row("SELECT value FROM sync_meta WHERE key = 'waiting'", [], |r| r.get(0)).optional().unwrap();
        out.insert("waiting".into(), json!([waiting.map(|w| serde_json::from_str::<J>(&w).unwrap())]));
        J::Object(out)
    }

    #[test]
    fn merge_matches_typescript_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("base.sqlite");
        std::fs::copy(fixtures().join("base.sqlite"), &db).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;").unwrap();
        let items: Vec<Item> = vectors()["items"].as_array().unwrap().iter().map(|x| x.as_object().unwrap().clone()).collect();
        Engine { conn: &conn }.apply(items).unwrap();
        let mut expected: J = serde_json::from_slice(&std::fs::read(fixtures().join("expected.json")).unwrap()).unwrap();
        // TypeScript stores `waiting` as a JSON string; compare it as a value.
        if let Some(w) = expected["waiting"][0].as_str().map(|s| serde_json::from_str::<J>(s).unwrap()) {
            expected["waiting"] = json!([w]);
        }
        // Rows are JSON with sorted keys on both sides.
        let got = dump(&conn);
        for (k, v) in expected.as_object().unwrap() {
            let g = &got[k];
            if let (Some(ev), Some(gv)) = (v.as_array(), g.as_array()) {
                if ev.first().map_or(false, |x| x.is_string()) && k != "waiting" {
                    let norm = |a: &Vec<J>| {
                        let mut x: Vec<J> = a.iter().map(|s| serde_json::from_str::<J>(s.as_str().unwrap()).unwrap()).collect();
                        x.sort_by_key(|y| y.to_string());
                        x
                    };
                    assert_eq!(norm(gv), norm(ev), "table {k}");
                    continue;
                }
            }
            assert_eq!(g, v, "{k}");
        }
    }

    /// Driven by tests/bgsync-e2e.test.ts: syncs the database in FOCUS_BG_ROOT with a real relay.
    #[test]
    #[ignore]
    fn external_sync() {
        let root = PathBuf::from(std::env::var("FOCUS_BG_ROOT").unwrap());
        let key = std::env::var("FOCUS_BG_KEY").unwrap();
        let r = tauri::async_runtime::block_on(sync_storage(&root, &key, None, || true)).unwrap();
        println!("BGSYNC pulled={} pushed={}", r.pulled, r.pushed);
    }

    #[test]
    fn hlc_and_dates() {
        assert_eq!(hlc(1_763_287_200_000, 3, "dev"), "1763287200000-00003-dev");
        assert_eq!(parse_hlc("1763287200000-00003-dev"), Some((1_763_287_200_000, 3)));
        assert_eq!(parse_iso_ms("2026-11-16T10:00:00.000Z"), Some(1_794_823_200_000));
        assert_eq!(from_legacy("2026-11-16T10:00:00.000Z|dev1"), "1794823200000-00000-dev1");
        assert_eq!(parse_iso_ms(&now_iso()).map(|m| m / 1000), Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64));
    }
}
