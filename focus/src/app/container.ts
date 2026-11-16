import type { SqlJsStatic } from 'sql.js';
import { createRepositories, type Repositories } from '@/data';
import { resetDeviceIdCache } from '@/data/repositories/base';
import type { DatabaseDriver } from '@/data/db/driver';
import type { Platform } from '@/platform/types';
import { ContentService } from '@/services/content-service';
import { DataService } from '@/services/data-service';
import { EventBus } from '@/services/events';
import { LabelService } from '@/services/label-service';
import { ProjectService } from '@/services/project-service';
import { QuickAddService } from '@/services/quick-add-service';
import { FilterService } from '@/services/filter-service';
import { ReminderService } from '@/services/reminder-service';
import { TemplateService } from '@/services/template-service';
import { PlanningService } from '@/services/planning-service';
import { InsightsService } from '@/services/insights-service';
import { WebhookService } from '@/services/webhook-service';
import { AutomationService } from '@/services/automation-service';
import { AiService } from '@/services/ai-service';
import { CaptureService } from '@/services/capture-service';
import { systemClock, TaskService, type Clock } from '@/services/task-service';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';

/**
 * Persistence (ADR-003). Each committed change is saved almost immediately
 * (bursts within `delayMs` are coalesced into one save) and again when the app
 * is backgrounded. A longer debounce (originally 250 ms) lost edits when the
 * page was reloaded or closed straight after a change — see TESTING.md.
 */
export class Saver {
  status: SaveStatus = 'saved';
  lastError: Error | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private savedVersion: number;

  constructor(private db: DatabaseDriver, private platform: Platform, private delayMs = 15) {
    this.savedVersion = db.version;
  }

  private set(s: SaveStatus) {
    this.status = s;
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  schedule() {
    if (this.status !== 'saving') this.set('pending');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Persist now. `force` saves even if nothing changed since the saver was created (start-up, migrations). */
  flush(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(async () => {
      if (!force && this.db.version === this.savedVersion && this.status !== 'error') return;
      const version = this.db.version;
      this.set('saving');
      try {
        await this.platform.persistence.save(this.db.export());
        this.savedVersion = version;
        this.lastError = null;
        this.set(this.db.version === version ? 'saved' : 'pending');
        if (this.db.version !== version) this.schedule();
      } catch (err) {
        this.lastError = err instanceof Error ? err : new Error(String(err));
        console.error('Saving failed', err);
        this.set('error');
        // Retry later; the in-memory data is intact.
        this.timer = setTimeout(() => void this.flush(), 5000);
      }
    });
    return this.chain;
  }
}

export interface AppContainer {
  repos: Repositories;
  events: EventBus;
  tasks: TaskService;
  projects: ProjectService;
  labels: LabelService;
  content: ContentService;
  quickAdd: QuickAddService;
  data: DataService;
  filters: FilterService;
  reminders: ReminderService;
  templates: TemplateService;
  planning: PlanningService;
  insights: InsightsService;
  webhooks: WebhookService;
  automations: AutomationService;
  ai: AiService;
  capture: CaptureService;
  saver: Saver;
  platform: Platform;
  /** Replace the live database (after restore), keeping services wired. */
  replaceDatabase(bytes: Uint8Array): void;
  dispose(): void;
}

export function createContainer(
  sql: SqlJsStatic,
  driverFactory: (bytes?: Uint8Array | null) => DatabaseDriver,
  initial: DatabaseDriver,
  platform: Platform,
  clock: Clock = systemClock,
): AppContainer {
  const events = new EventBus();
  let teardown: (() => void)[] = [];

  const build = (db: DatabaseDriver) => {
    const repos = createRepositories(db);
    const settings = () => repos.settings.getAll();
    const tasks = new TaskService(repos, events, clock, settings);
    const projects = new ProjectService(repos, events);
    const labels = new LabelService(repos);
    const content = new ContentService(repos, platform.files);
    const quickAdd = new QuickAddService(repos, tasks, projects, labels);
    const data = new DataService(repos, { tasks, projects, labels }, platform.files, sql);
    const filters = new FilterService(repos, () => clock.now());
    const reminders = new ReminderService(repos);
    const templates = new TemplateService(repos, tasks, projects, labels);
    const planning = new PlanningService(repos, tasks, () => clock.now());
    const insights = new InsightsService(repos, () => clock.now());
    const webhooks = new WebhookService(repos, platform.http, platform.secrets);
    const ai = new AiService(repos, platform.http, platform.secrets);
    const capture = new CaptureService(repos, quickAdd, ai, () => clock.now());
    const automations = new AutomationService(repos, events, { tasks, projects, content, templates, webhooks, filters }, clock);
    const saver = new Saver(db, platform);
    teardown.push(db.subscribe(() => saver.schedule()));
    teardown.push(() => automations.dispose());
    teardown.push(platform.lifecycle.onPause(() => saver.flush()));
    return { repos, tasks, projects, labels, content, quickAdd, data, filters, reminders, templates, planning, insights, webhooks, automations, ai, capture, saver };
  };

  const container: AppContainer = {
    ...build(initial),
    events,
    platform,
    replaceDatabase(bytes) {
      const old = container.repos.db;
      teardown.forEach((f) => f());
      teardown = [];
      resetDeviceIdCache();
      const next = driverFactory(bytes);
      Object.assign(container, build(next));
      old.close();
      container.saver.schedule();
    },
    dispose() {
      teardown.forEach((f) => f());
      container.repos.db.close();
    },
  };
  return container;
}
