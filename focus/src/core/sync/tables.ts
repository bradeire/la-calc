/**
 * What is synchronised between devices, in foreign-key-safe order (parents first), with the
 * columns of each table as of schema v6. A test checks these match the real schema; a future
 * migration that adds a column to a synced table must also regenerate the sync triggers.
 *
 * Not synced: external calendars and webhooks/integrations (their addresses and secrets live in
 * each device's secure storage), backup history, the local change log, and device-specific
 * settings (theme, onboarding, local API, layout). Attachment *files* travel separately as
 * encrypted blobs (see SyncService); their rows are synced here.
 */
export interface SyncTable {
  name: string;
  key: readonly string[];
  columns: readonly string[];
}

const t = (name: string, key: string[], columns: string): SyncTable => ({ name, key, columns: columns.split(' ') });

export const SYNC_TABLES: readonly SyncTable[] = [
  t('settings', ['key'], 'key value_json updated_at'),
  t('projects', ['id'], 'id name description notes color icon parent_id layout is_favorite settings_json archived_at created_at updated_at deleted_at sort_order collapsed is_sample'),
  t('sections', ['id'], 'id project_id name sort_order collapsed created_at updated_at deleted_at'),
  t('labels', ['id'], 'id name color is_favorite sort_order created_at updated_at deleted_at is_sample'),
  t(
    'tasks',
    ['id'],
    'id title description project_id section_id parent_id priority status start_date scheduled_date scheduled_time deadline duration_minutes actual_minutes completed_at created_at updated_at deleted_at sort_order pinned_today collapsed series_id is_sample',
  ),
  t('recurrence_rules', ['id'], 'id task_id rule_version rule_json source_text created_at updated_at'),
  t('task_labels', ['task_id', 'label_id'], 'task_id label_id'),
  t('task_dependencies', ['task_id', 'depends_on_id'], 'task_id depends_on_id created_at'),
  t('reminders', ['id'], 'id task_id kind remind_at offset_minutes created_at delivered_at dismissed_at snoozed_until'),
  t('comments', ['id'], 'id task_id project_id body created_at updated_at deleted_at'),
  t('attachments', ['id'], 'id task_id project_id file_name mime_type size_bytes storage_key created_at deleted_at'),
  t('time_entries', ['id'], 'id task_id started_at ended_at minutes note source created_at updated_at deleted_at'),
  t('activity_log', ['id'], 'id entity_type entity_id action payload_json created_at'),
  t('project_templates', ['id'], 'id name description template_json created_at updated_at deleted_at'),
  t('saved_filters', ['id'], 'id name query definition_json color is_favorite sort_order created_at updated_at deleted_at'),
  t('automations', ['id'], 'id name enabled trigger_json conditions_json actions_json max_runs_per_hour last_run_at created_at updated_at deleted_at'),
  t('automation_runs', ['id'], 'id automation_id event_key status started_at finished_at error details_json'),
];

/** Preferences shared by all devices; everything else in `settings` stays per device. */
export const SYNCED_SETTINGS = ['dateOrder', 'hour12', 'weekStartsOn', 'workingHours', 'defaultEstimate', 'autoCompleteParent', 'showCompletedInProjects', 'goals'] as const;

export const KEY_SEPARATOR = '\u001f';

export const tableByName = new Map(SYNC_TABLES.map((x) => [x.name, x]));

/** SQL expression for a row's key: in a trigger (NEW./OLD.) or over a table (no prefix). */
export function keyExpr(tb: SyncTable, prefix: 'NEW' | 'OLD' | '' = ''): string {
  return tb.key.map((k) => (prefix ? `${prefix}.${k}` : k)).join(` || char(31) || `);
}

// ---------- Hybrid logical clock versions ----------
//
// A version is "<13-digit ms>-<5-digit counter>-<device>": lexical order = causal order. Every
// local change takes max(wall clock, last seen) and bumps the counter on ties; every received
// version advances the local clock, so an edit made after seeing another device's change always
// wins, even if this device's clock is behind.

export const hlc = (ms: number, counter: number, device: string) => `${String(Math.max(0, Math.floor(ms))).padStart(13, '0')}-${String(counter).padStart(5, '0')}-${device}`;

export function parseHlc(v: string): { ms: number; counter: number; device: string } | null {
  const m = /^(\d{13})-(\d{5})-(.+)$/.exec(v);
  return m ? { ms: Number(m[1]), counter: Number(m[2]), device: m[3]! } : null;
}

/** Version 1 format ("ISO time|device") to an HLC version. */
export function fromLegacyVersion(v: string): string {
  const i = v.lastIndexOf('|');
  const ms = Date.parse(i >= 0 ? v.slice(0, i) : v);
  return hlc(Number.isFinite(ms) ? ms : 0, 0, i >= 0 ? v.slice(i + 1) : 'legacy');
}
