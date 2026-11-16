import { keyExpr, SYNC_TABLES, SYNCED_SETTINGS } from '@/core/sync/tables';
import type { Migration } from './types';

const WHEN = '(SELECT enabled FROM sync_control WHERE id = 1) = 1 AND (SELECT applying FROM sync_control WHERE id = 1) = 0';
const VERSION = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || '|' || (SELECT device_id FROM sync_control WHERE id = 1)";
const settingsOnly = (p: 'NEW' | 'OLD') => ` AND ${p}.key IN (${SYNCED_SETTINGS.map((k) => `'${k}'`).join(', ')})`;

function triggers(): string {
  const out: string[] = [];
  for (const t of SYNC_TABLES) {
    for (const [ev, p] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']] as const) {
      const key = keyExpr(t, p);
      const extra = t.name === 'settings' ? settingsOnly(p) : '';
      out.push(`CREATE TRIGGER sync_${t.name}_${ev.toLowerCase()} AFTER ${ev} ON ${t.name} WHEN ${WHEN}${extra} BEGIN
  INSERT INTO sync_changes (tbl, row_key) VALUES ('${t.name}', ${key});
  INSERT INTO sync_versions (tbl, row_key, version) VALUES ('${t.name}', ${key}, ${VERSION})
    ON CONFLICT (tbl, row_key) DO UPDATE SET version = excluded.version;
END;`);
    }
  }
  return out.join('\n');
}

/**
 * Sync (end-to-end encrypted, ADR-019). Triggers record which rows changed, and a version
 * (time|device) for last-writer-wins merging. They only run while sync is enabled, and not
 * while remote changes are being applied (so changes never echo back).
 */
export const migration005: Migration = {
  version: 5,
  name: 'sync',
  up: `
CREATE TABLE sync_control (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  enabled   INTEGER NOT NULL DEFAULT 0,
  applying  INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL
);
INSERT INTO sync_control (id, enabled, applying, device_id) VALUES (1, 0, 0, lower(hex(randomblob(16))));
CREATE TABLE sync_changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl     TEXT NOT NULL,
  row_key TEXT NOT NULL
);
CREATE TABLE sync_versions (
  tbl     TEXT NOT NULL,
  row_key TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tbl, row_key)
);
CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
${triggers()}
`,
  down: `
${SYNC_TABLES.flatMap((t) => ['insert', 'update', 'delete'].map((e) => `DROP TRIGGER IF EXISTS sync_${t.name}_${e};`)).join('\n')}
DROP TABLE IF EXISTS sync_meta;
DROP TABLE IF EXISTS sync_versions;
DROP TABLE IF EXISTS sync_changes;
DROP TABLE IF EXISTS sync_control;
`,
};
