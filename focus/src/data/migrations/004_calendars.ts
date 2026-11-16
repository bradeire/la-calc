import type { Migration } from './types';

/**
 * Phase 4: external calendars (read-only). Subscription addresses are secrets and live in the
 * platform SecretStore; this table only records names, colours and sync status. Events are a
 * cache of the expanded occurrences, replaced on every sync.
 *
 * Replaces the Phase 1 placeholder table calendar_connections, which nothing ever wrote to.
 */
export const migration004: Migration = {
  version: 4,
  name: 'calendars',
  up: `
DROP TABLE IF EXISTS calendar_connections;
CREATE TABLE calendar_sources (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('url','file')),
  visible        INTEGER NOT NULL DEFAULT 1,
  blocks_time    INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE TABLE external_events (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  uid        TEXT NOT NULL,
  title      TEXT NOT NULL,
  location   TEXT NOT NULL DEFAULT '',
  all_day    INTEGER NOT NULL,
  start_at   TEXT NOT NULL,
  end_at     TEXT NOT NULL
);
CREATE INDEX idx_external_events_source ON external_events(source_id);
CREATE INDEX idx_external_events_start ON external_events(start_at);
`,
  down: `
DROP TABLE IF EXISTS external_events;
DROP TABLE IF EXISTS calendar_sources;
CREATE TABLE calendar_connections (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  config_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  credential_ref TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`,
};
