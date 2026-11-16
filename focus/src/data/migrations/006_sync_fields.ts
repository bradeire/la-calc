import { SYNC_TABLES, SYNCED_SETTINGS, type SyncTable } from '@/core/sync/tables';
import { V5_TABLES, v5Triggers } from './005_sync';
import type { Migration } from './types';

/**
 * Sync v2 (ADR-020): field-level last-writer-wins with hybrid-logical-clock versions.
 * Replaces row versions (`sync_versions`) with per-field versions (`sync_fields`) and deletion
 * versions (`sync_tombstones`); adds attachments to sync. Existing versions are converted, so a
 * device that already syncs carries on without re-uploading.
 */
const NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";
const BUMP = `UPDATE sync_control SET hlc_counter = CASE WHEN ${NOW_MS} > hlc_ms THEN 0 ELSE hlc_counter + 1 END, hlc_ms = MAX(hlc_ms, ${NOW_MS}) WHERE id = 1;`;
const V = "(SELECT printf('%013d-%05d-%s', hlc_ms, hlc_counter, device_id) FROM sync_control WHERE id = 1)";
const WHEN = '(SELECT enabled FROM sync_control WHERE id = 1) = 1 AND (SELECT applying FROM sync_control WHERE id = 1) = 0';
const CONV = (v: string) =>
  `printf('%013d-%05d-%s', CAST(ROUND((julianday(substr(${v}, 1, instr(${v}, '|') - 1)) - 2440587.5) * 86400000) AS INTEGER), 0, substr(${v}, instr(${v}, '|') + 1))`;
const key = (t: SyncTable, p: string) => t.key.map((k) => `${p}.${k}`).join(' || char(31) || ');
const colValues = (t: SyncTable) => `(VALUES ${t.columns.map((c) => `('${c}')`).join(', ')})`;
const settingsOnly = (p: string) => ` AND ${p}.key IN (${SYNCED_SETTINGS.map((k) => `'${k}'`).join(', ')})`;
const UPSERT_FIELD = 'ON CONFLICT (tbl, row_key, col) DO UPDATE SET version = excluded.version';

export function v6Triggers(): string {
  const out: string[] = [];
  for (const t of SYNC_TABLES) {
    const extra = (p: string) => (t.name === 'settings' ? settingsOnly(p) : '');
    out.push(`CREATE TRIGGER sync_${t.name}_insert AFTER INSERT ON ${t.name} WHEN ${WHEN}${extra('NEW')} BEGIN
  ${BUMP}
  INSERT INTO sync_changes (tbl, row_key) VALUES ('${t.name}', ${key(t, 'NEW')});
  INSERT INTO sync_fields (tbl, row_key, col, version) SELECT '${t.name}', ${key(t, 'NEW')}, column1, ${V} FROM ${colValues(t)} WHERE 1 ${UPSERT_FIELD};
END;`);
    out.push(`CREATE TRIGGER sync_${t.name}_update AFTER UPDATE ON ${t.name} WHEN ${WHEN}${extra('NEW')} BEGIN
  ${BUMP}
  INSERT INTO sync_changes (tbl, row_key) VALUES ('${t.name}', ${key(t, 'NEW')});
${t.columns.map((c) => `  INSERT INTO sync_fields (tbl, row_key, col, version) SELECT '${t.name}', ${key(t, 'NEW')}, '${c}', ${V} WHERE OLD.${c} IS NOT NEW.${c} ${UPSERT_FIELD};`).join('\n')}
END;`);
    out.push(`CREATE TRIGGER sync_${t.name}_delete AFTER DELETE ON ${t.name} WHEN ${WHEN}${extra('OLD')} BEGIN
  ${BUMP}
  INSERT INTO sync_changes (tbl, row_key) VALUES ('${t.name}', ${key(t, 'OLD')});
  INSERT INTO sync_tombstones (tbl, row_key, version) VALUES ('${t.name}', ${key(t, 'OLD')}, ${V}) ON CONFLICT (tbl, row_key) DO UPDATE SET version = excluded.version;
END;`);
  }
  return out.join('\n');
}

function convert(): string {
  const out: string[] = [];
  for (const t of SYNC_TABLES) {
    if (!V5_TABLES.some((x) => x.name === t.name)) continue;
    out.push(`INSERT OR IGNORE INTO sync_fields (tbl, row_key, col, version)
  SELECT v.tbl, v.row_key, c.column1, ${CONV('v.version')} FROM sync_versions v JOIN ${t.name} x ON (${key(t, 'x')}) = v.row_key, ${colValues(t)} c WHERE v.tbl = '${t.name}';`);
    out.push(`INSERT OR IGNORE INTO sync_tombstones (tbl, row_key, version)
  SELECT v.tbl, v.row_key, ${CONV('v.version')} FROM sync_versions v WHERE v.tbl = '${t.name}' AND NOT EXISTS (SELECT 1 FROM ${t.name} x WHERE (${key(t, 'x')}) = v.row_key);`);
  }
  // Attachments are new to sync: queue them if sync is already on.
  const att = SYNC_TABLES.find((x) => x.name === 'attachments')!;
  out.push(`INSERT INTO sync_changes (tbl, row_key) SELECT 'attachments', id FROM attachments WHERE (SELECT enabled FROM sync_control WHERE id = 1) = 1;`);
  out.push(`INSERT OR IGNORE INTO sync_fields (tbl, row_key, col, version)
  SELECT 'attachments', a.id, c.column1, ${CONV("a.created_at || '|' || (SELECT device_id FROM sync_control WHERE id = 1)")} FROM attachments a, ${colValues(att)} c
  WHERE (SELECT enabled FROM sync_control WHERE id = 1) = 1;`);
  return out.join('\n');
}

export const migration006: Migration = {
  version: 6,
  name: 'sync_fields',
  up: `
${V5_TABLES.flatMap((t) => ['insert', 'update', 'delete'].map((e) => `DROP TRIGGER IF EXISTS sync_${t.name}_${e};`)).join('\n')}
ALTER TABLE sync_control ADD COLUMN hlc_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_control ADD COLUMN hlc_counter INTEGER NOT NULL DEFAULT 0;
CREATE TABLE sync_fields (
  tbl     TEXT NOT NULL,
  row_key TEXT NOT NULL,
  col     TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tbl, row_key, col)
);
CREATE TABLE sync_tombstones (
  tbl     TEXT NOT NULL,
  row_key TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tbl, row_key)
);
${convert()}
UPDATE sync_control SET hlc_ms = COALESCE((SELECT MAX(CAST(substr(version, 1, 13) AS INTEGER)) FROM sync_fields), 0) WHERE id = 1;
DROP TABLE sync_versions;
${v6Triggers()}
`,
  down: `
${SYNC_TABLES.flatMap((t) => ['insert', 'update', 'delete'].map((e) => `DROP TRIGGER IF EXISTS sync_${t.name}_${e};`)).join('\n')}
DROP TABLE IF EXISTS sync_tombstones;
DROP TABLE IF EXISTS sync_fields;
CREATE TABLE sync_versions (tbl TEXT NOT NULL, row_key TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (tbl, row_key));
ALTER TABLE sync_control DROP COLUMN hlc_counter;
ALTER TABLE sync_control DROP COLUMN hlc_ms;
${v5Triggers()}
`,
};
