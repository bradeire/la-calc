# Focus — Database

SQLite 3.54 (sql.js WASM build, includes FTS4 and JSON1). Schema lives in `src/data/migrations`.
All SQL lives in `src/data/repositories`. Conventions are in DECISIONS.md (ADR-004).

## Conventions

- IDs: UUID v4 text. Timestamps: UTC ISO-8601 text. Calendar dates: floating `YYYY-MM-DD`; time: `HH:mm`.
- Soft delete via `deleted_at`; related rows deleted together share the same timestamp so they restore together.
- Every write records a row in `change_log` (future sync).
- `PRAGMA foreign_keys = ON` (re-applied after every `export()`, which resets pragmas in sql.js).

## Tables (migration 001)

| Table | Purpose | Notes |
|---|---|---|
| `projects` | Projects, nested via `parent_id` | `layout` ∈ list/board/table/calendar; `archived_at`; `settings_json`; `is_sample` |
| `sections` | Sections within a project | cascade on project hard-delete |
| `tasks` | Tasks and subtasks (`parent_id`) | `priority` 1–4 (1 = highest); `status` CHECK list; independent `start_date`, `scheduled_date`, `scheduled_time`, `deadline`; `duration_minutes`, `actual_minutes`; `series_id` for recurrence; `pinned_today` |
| `recurrence_rules` | One structured rule per recurring task | `rule_json` (validated, versioned `v`), `source_text` |
| `labels` | Labels | unique name (case-insensitive) among non-deleted |
| `task_labels` | Task ↔ label | |
| `reminders` | Absolute or relative reminders | CHECK ensures the matching field is set |
| `attachments` | Metadata; bytes live in the platform FileStore | keyed by `storage_key` |
| `comments` | Task or project comments | |
| `activity_log` | Per-entity history with JSON payload | |
| `task_dependencies` | A depends on B | CHECK no self-dependency; cycle check in service (Phase 2) |
| `time_entries` | Timer and manual time logs | soft-deletable for corrections |
| `project_templates` | Phase 2 | |
| `saved_filters` | Phase 2 | |
| `automations`, `automation_runs` | Phase 3 | `UNIQUE(automation_id, event_key)` prevents duplicate execution |
| `calendar_connections` | Phase 4 | `credential_ref` only — never secrets |
| `settings` | Key → JSON value | validated per key with Zod; one bad value cannot reset others |
| `backup_history` | Backups made and verified | |
| `change_log` | Sync change tracking | |
| `tasks_fts`, `comments_fts` | FTS4 external-content indexes | kept in sync by triggers |
| `schema_migrations` | Applied migration versions | |

Indexes cover project/section, parent, status, scheduled date, deadline, completion time, deletion, series,
label membership, activity by entity/time, and time entries.

## Phase 4 tables (migration 004)

| Table | Purpose |
|---|---|
| `calendar_sources` | External calendars: name, colour, kind (`url`/`file`), shown, counts as busy, last sync/error. The subscription address is in the SecretStore. |
| `external_events` | Expanded occurrences cached per source (replaced on each sync): uid, title, location, all-day flag, start/end (UTC instant or date). |

Migration 004 also drops `calendar_connections`, an unused placeholder from migration 001 (always empty).
Settings gained `insightsLayout`, `goals` and `localApi` (validated per key).

## Sync tables (migration 005)

| Table | Purpose |
|---|---|
| `sync_control` | One row: sync enabled, applying-remote flag, this device's random sync id. |
| `sync_changes` | Rows changed locally since the last push (filled by triggers). |
| `sync_versions` | Last known version (`ISO time|device`) of every synced row, for last-writer-wins. |
| `sync_meta` | Relay address, pull cursor, last sync/error, rows waiting for their parent, timed-automation choice. |

Triggers `sync_<table>_<insert|update|delete>` exist on every synced table (see `src/core/sync/tables.ts`).

## Migrations

- `migrate(db)` applies pending migrations, **each in its own transaction**; a failure rolls back that migration.
- Before migrating an existing database, the app stores a snapshot `pre-migration-v<N>`.
- A database with a schema newer than the app supports is refused without modification (`NewerSchemaError`).
- Every migration has a `down` script; `rollback(db, target)` exists for tests and for explicit, consented downgrades.
- Adding a migration: create `src/data/migrations/00N_name.ts`, append to `MIGRATIONS`, add a test.

## Persistence (browser)

IndexedDB database `focus`, store `database`: keys `current`, `previous` (rotated on every save), `savedAt`,
and `snapshot:*`. Store `files` holds attachment bytes. Saves follow each change within ~15 ms (bursts coalesced) and are forced on page hide.
