import type { Migration } from './types';

/** Phase 3: user-configured integrations (webhooks). Secrets live in the platform SecretStore, never here. */
export const migration003: Migration = {
  version: 3,
  name: 'integrations',
  up: `
CREATE TABLE integrations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('webhook')),
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_automation_runs_time ON automation_runs(automation_id, started_at);
`,
  down: `
DROP INDEX IF EXISTS idx_automation_runs_time;
DROP TABLE IF EXISTS integrations;
`,
};
