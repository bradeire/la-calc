/**
 * What is synchronised between devices, in foreign-key-safe order (parents first).
 *
 * Deliberately NOT synced: attachments (file contents stay on the device that added them),
 * external calendars and webhooks/integrations (their addresses and secrets live in each
 * device's secure storage), backup history, the local change log, and device-specific
 * settings (theme, onboarding, local API, layout).
 */
export interface SyncTable {
  name: string;
  key: readonly string[];
}

export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'settings', key: ['key'] },
  { name: 'projects', key: ['id'] },
  { name: 'sections', key: ['id'] },
  { name: 'labels', key: ['id'] },
  { name: 'tasks', key: ['id'] },
  { name: 'recurrence_rules', key: ['id'] },
  { name: 'task_labels', key: ['task_id', 'label_id'] },
  { name: 'task_dependencies', key: ['task_id', 'depends_on_id'] },
  { name: 'reminders', key: ['id'] },
  { name: 'comments', key: ['id'] },
  { name: 'time_entries', key: ['id'] },
  { name: 'activity_log', key: ['id'] },
  { name: 'project_templates', key: ['id'] },
  { name: 'saved_filters', key: ['id'] },
  { name: 'automations', key: ['id'] },
  { name: 'automation_runs', key: ['id'] },
];

/** Preferences shared by all devices; everything else in `settings` stays per device. */
export const SYNCED_SETTINGS = ['dateOrder', 'hour12', 'weekStartsOn', 'workingHours', 'defaultEstimate', 'autoCompleteParent', 'showCompletedInProjects', 'goals'] as const;

export const KEY_SEPARATOR = '\u001f';

export const tableByName = new Map(SYNC_TABLES.map((t) => [t.name, t]));

/** SQL expression for a row's key in a trigger (NEW./OLD. prefix). */
export function keyExpr(t: SyncTable, prefix: 'NEW' | 'OLD'): string {
  return t.key.map((k) => `${prefix}.${k}`).join(` || char(31) || `);
}
