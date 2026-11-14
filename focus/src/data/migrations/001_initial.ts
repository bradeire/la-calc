import type { Migration } from './types';

/**
 * Initial schema. Contains every entity the five phases need so that later
 * phases add behaviour, not restructuring (ARCHITECTURE.md). See DATABASE.md.
 */
export const migration001: Migration = {
  version: 1,
  name: 'initial schema',
  up: `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#64748b',
  icon          TEXT NOT NULL DEFAULT 'folder',
  parent_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  layout        TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list','board','table','calendar')),
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sort_order    REAL NOT NULL DEFAULT 0,
  collapsed     INTEGER NOT NULL DEFAULT 0,
  is_sample     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_projects_parent ON projects(parent_id);

CREATE TABLE sections (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  REAL NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_sections_project ON sections(project_id);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
  section_id       TEXT REFERENCES sections(id) ON DELETE SET NULL,
  parent_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  priority         INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  status           TEXT NOT NULL DEFAULT 'inbox'
                   CHECK (status IN ('inbox','active','in_progress','waiting','completed','cancelled','archived')),
  start_date       TEXT,
  scheduled_date   TEXT,
  scheduled_time   TEXT,
  deadline         TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  actual_minutes   INTEGER NOT NULL DEFAULT 0,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  sort_order       REAL NOT NULL DEFAULT 0,
  pinned_today     INTEGER NOT NULL DEFAULT 0,
  collapsed        INTEGER NOT NULL DEFAULT 0,
  series_id        TEXT,
  is_sample        INTEGER NOT NULL DEFAULT 0,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_tasks_project   ON tasks(project_id, section_id);
CREATE INDEX idx_tasks_parent    ON tasks(parent_id);
CREATE INDEX idx_tasks_status    ON tasks(status);
CREATE INDEX idx_tasks_scheduled ON tasks(scheduled_date);
CREATE INDEX idx_tasks_deadline  ON tasks(deadline);
CREATE INDEX idx_tasks_completed ON tasks(completed_at);
CREATE INDEX idx_tasks_deleted   ON tasks(deleted_at);
CREATE INDEX idx_tasks_series    ON tasks(series_id);

CREATE TABLE recurrence_rules (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL,
  rule_json    TEXT NOT NULL CHECK (json_valid(rule_json)),
  source_text  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#64748b',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  is_sample   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_labels_name ON labels(name COLLATE NOCASE) WHERE deleted_at IS NULL;

CREATE TABLE task_labels (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels(label_id);

CREATE TABLE reminders (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('absolute','relative')),
  remind_at      TEXT,
  offset_minutes INTEGER,
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  dismissed_at   TEXT,
  snoozed_until  TEXT,
  CHECK ((kind = 'absolute' AND remind_at IS NOT NULL) OR (kind = 'relative' AND offset_minutes IS NOT NULL))
);
CREATE INDEX idx_reminders_task ON reminders(task_id);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK (task_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_project ON attachments(project_id);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (task_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE INDEX idx_comments_task ON comments(task_id);

CREATE TABLE activity_log (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activity_entity ON activity_log(entity_id, created_at);
CREATE INDEX idx_activity_time ON activity_log(created_at);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_dependencies_on ON task_dependencies(depends_on_id);

CREATE TABLE time_entries (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  minutes    INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL CHECK (source IN ('timer','manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_time_task ON time_entries(task_id);
CREATE INDEX idx_time_started ON time_entries(started_at);

CREATE TABLE project_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  template_json TEXT NOT NULL CHECK (json_valid(template_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE saved_filters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  query           TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(definition_json)),
  color           TEXT NOT NULL DEFAULT '#64748b',
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  sort_order      REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE automations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  trigger_json    TEXT NOT NULL CHECK (json_valid(trigger_json)),
  conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conditions_json)),
  actions_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions_json)),
  max_runs_per_hour INTEGER NOT NULL DEFAULT 60,
  last_run_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  event_key     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','skipped')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}',
  UNIQUE (automation_id, event_key)
);

CREATE TABLE calendar_connections (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  config_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  -- Reference to a secret in platform secure storage. Never the secret itself.
  credential_ref TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE backup_history (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  size_bytes  INTEGER,
  location    TEXT,
  checksum    TEXT,
  verified_at TEXT,
  status      TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  changed_at TEXT NOT NULL,
  device_id  TEXT NOT NULL
);
CREATE INDEX idx_change_log_entity ON change_log(entity, entity_id);

-- Full-text search (FTS4, external content) kept in sync by triggers.
CREATE VIRTUAL TABLE tasks_fts USING fts4(content="tasks", title, description, tokenize=unicode61);
CREATE TRIGGER tasks_fts_bd BEFORE DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE docid = old.rowid;
END;
CREATE TRIGGER tasks_fts_bu BEFORE UPDATE OF title, description ON tasks BEGIN
  DELETE FROM tasks_fts WHERE docid = old.rowid;
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description ON tasks BEGIN
  INSERT INTO tasks_fts(docid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(docid, title, description) VALUES (new.rowid, new.title, new.description);
END;

CREATE VIRTUAL TABLE comments_fts USING fts4(content="comments", body, tokenize=unicode61);
CREATE TRIGGER comments_fts_bd BEFORE DELETE ON comments BEGIN
  DELETE FROM comments_fts WHERE docid = old.rowid;
END;
CREATE TRIGGER comments_fts_bu BEFORE UPDATE OF body ON comments BEGIN
  DELETE FROM comments_fts WHERE docid = old.rowid;
END;
CREATE TRIGGER comments_fts_au AFTER UPDATE OF body ON comments BEGIN
  INSERT INTO comments_fts(docid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(docid, body) VALUES (new.rowid, new.body);
END;
`,
  down: `
DROP TRIGGER IF EXISTS tasks_fts_bd;
DROP TRIGGER IF EXISTS tasks_fts_bu;
DROP TRIGGER IF EXISTS tasks_fts_au;
DROP TRIGGER IF EXISTS tasks_fts_ai;
DROP TRIGGER IF EXISTS comments_fts_bd;
DROP TRIGGER IF EXISTS comments_fts_bu;
DROP TRIGGER IF EXISTS comments_fts_au;
DROP TRIGGER IF EXISTS comments_fts_ai;
DROP TABLE IF EXISTS comments_fts;
DROP TABLE IF EXISTS tasks_fts;
DROP TABLE IF EXISTS change_log;
DROP TABLE IF EXISTS backup_history;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS calendar_connections;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automations;
DROP TABLE IF EXISTS saved_filters;
DROP TABLE IF EXISTS project_templates;
DROP TABLE IF EXISTS time_entries;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS activity_log;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS task_labels;
DROP TABLE IF EXISTS labels;
DROP TABLE IF EXISTS recurrence_rules;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS projects;
`,
};
