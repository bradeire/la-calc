import { z } from 'zod';
import { PALETTE } from '@/core/domain/types';
import type { DatabaseDriver } from '../db/driver';
import { nowIso } from './base';

/** Accent options, chosen so white text on them meets WCAG AA (≥ 4.5:1). */
export const ACCENTS = ['#2563eb', '#4f46e5', '#7c3aed', '#0f766e', '#15803d', '#c2410c', '#be185d', '#dc2626', '#475569'] as const;

const dashboardWidget = z.enum(['today', 'overdue', 'deadlines', 'waiting', 'workload', 'projects', 'capture', 'recent', 'stats']);

export const settingsSchema = z.object({
  onboarded: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(ACCENTS[0]),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  dateOrder: z.enum(['dmy', 'mdy', 'ymd']).default('dmy'),
  hour12: z.boolean().default(false),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]).default(1),
  workingHours: z
    .object({
      days: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4]),
      start: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
      end: z.string().regex(/^\d{2}:\d{2}$/).default('17:30'),
    })
    .default({ days: [0, 1, 2, 3, 4], start: '09:00', end: '17:30' }),
  autoCompleteParent: z.boolean().default(false),
  /** Minutes assumed for tasks without an estimate when calculating workload. */
  defaultEstimate: z.number().int().min(0).max(480).default(30),
  showCompletedInProjects: z.boolean().default(false),
  notificationsEnabled: z.boolean().default(false),
  reduceMotion: z.enum(['system', 'on', 'off']).default('system'),
  fontScale: z.number().min(0.85).max(1.4).default(1),
  defaultProjectColor: z.string().default(PALETTE[0]!.value),
  dashboardWidgets: z.array(dashboardWidget).default(['today', 'overdue', 'deadlines', 'waiting', 'projects', 'recent']),
});

export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export class SettingsRepository {
  constructor(private db: DatabaseDriver) {}

  getAll(): Settings {
    const rows = this.db.all<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value_json);
      } catch (err) {
        console.error(`Ignoring unreadable setting ${r.key}`, err);
      }
    }
    // Validate each key independently so one bad value cannot reset everything.
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const shape = settingsSchema.shape;
    for (const key of Object.keys(shape) as (keyof Settings)[]) {
      if (!(key in raw)) continue;
      const parsed = shape[key].safeParse(raw[key]);
      if (parsed.success) out[key] = parsed.data;
      else console.error(`Invalid value for setting ${key}; using default`);
    }
    return out as Settings;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const valid = settingsSchema.shape[key].parse(value);
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(valid), nowIso()],
    );
  }
}
