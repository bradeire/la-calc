import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Database, Download, FlaskConical, Keyboard, Monitor, Moon, Palette, Settings as SettingsIcon, Sun, Upload } from 'lucide-react';
import { WEEKDAY_SHORT } from '@/core/dates';
import { LATEST_SCHEMA_VERSION } from '@/data/migrations';
import { ACCENTS, type Settings } from '@/data/repositories/settings';
import type { FocusBackup } from '@/services/data-service';
import { useUi } from '@/state/ui-store';
import { errorMessage, useAction, useApp, useQuery, useSettings } from '../hooks';
import { Button, ConfirmDialog, Select, Switch, cx } from '../primitives';
import { ViewBody } from '../components/common';
import { ViewHeader } from '../layout/Chrome';
import { saveFile } from '../download';
import { TransferControls } from '../components/TransferControls';
import { AddFromAssistantSettings, AiSettings, CalendarSettings, LocalApiSettings, WebhookSettings } from './IntegrationSettings';

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-2">
      <h2 className="mb-2 flex items-center gap-2 text-[0.95rem] font-semibold">
        <span className="text-muted">{icon}</span>
        {title}
      </h2>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface">{children}</div>
    </section>
  );
}

function Item({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-[0.93rem]">
          {label}
        </label>
        {hint && <p className="text-[0.8rem] text-muted">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function useSetting() {
  const app = useApp();
  const act = useAction();
  return <K extends keyof Settings>(key: K, value: Settings[K]) => act(() => app.repos.settings.set(key, value));
}

export function SettingsView() {
  const app = useApp();
  const act = useAction();
  const s = useSettings();
  const set = useSetting();
  const pushToast = useUi((st) => st.pushToast);
  const setShortcutsOpen = useUi((st) => st.setShortcutsOpen);
  const hasSample = useQuery(() => app.data.hasSampleData(), []);
  const counts = useQuery(
    () => ({
      tasks: Number(app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL')?.n ?? 0),
      bytes: app.repos.db.export().length,
    }),
    [],
  );
  const lastBackup = useQuery(() => app.repos.db.get<{ created_at: string; kind: string }>('SELECT created_at, kind FROM backup_history ORDER BY created_at DESC LIMIT 1'), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ kind: 'json'; backup: FocusBackup; summary: string } | { kind: 'sqlite'; bytes: Uint8Array; summary: string } | null>(null);
  const [confirmRemoveSample, setConfirmRemoveSample] = useState(false);
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  const exportJson = async () => {
    try {
      const backup = await app.data.exportJson();
      const json = JSON.stringify(backup);
      app.data.verifyJsonBackup(json); // round-trip check before handing the file over
      app.data.recordBackup('json', json.length, null, 'verified');
      const where = await saveFile(app.platform, `focus-backup-${stamp()}.json`, json, 'application/json');
      pushToast({ message: `Backup created and verified${where ? `. ${where}` : ''}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const exportSqlite = async () => {
    try {
      const { bytes, sha256 } = await app.data.exportSqlite();
      app.data.verifySqlite(bytes);
      const where = await saveFile(app.platform, `focus-${stamp()}.sqlite`, bytes, 'application/vnd.sqlite3');
      pushToast({ message: `Database exported (SHA-256 ${sha256.slice(0, 12)}…)${where ? `. ${where}` : ''}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const chooseImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isSqlite = new TextDecoder().decode(bytes.slice(0, 15)) === 'SQLite format 3';
      if (isSqlite) {
        const info = app.data.verifySqlite(bytes);
        setPending({ kind: 'sqlite', bytes, summary: `${info.tasks} tasks, ${info.projects} projects, ${info.labels} labels` });
      } else {
        const { backup, summary } = app.data.inspectJson(new TextDecoder().decode(bytes));
        setPending({ kind: 'json', backup, summary: `${summary.tasks} tasks, ${summary.projects} projects, ${summary.labels} labels (exported ${new Date(backup.exportedAt).toLocaleString('en-GB')})` });
      }
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const restore = async () => {
    if (!pending) return;
    try {
      // Keep the current data as a snapshot before replacing anything.
      await app.platform.persistence.saveSnapshot(`pre-restore-${new Date().toISOString()}`, app.repos.db.export());
      if (pending.kind === 'json') {
        await app.data.restoreJson(pending.backup);
        await app.saver.flush();
        pushToast({ message: 'Backup restored', tone: 'success' });
      } else {
        await app.platform.persistence.save(pending.bytes);
        window.location.reload();
      }
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  return (
    <>
      <ViewHeader title="Settings" icon={<SettingsIcon size={22} className="text-muted" />} />
      <ViewBody>
        <Group title="Appearance" icon={<Palette size={16} />}>
          <Item label="Theme">
            <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Theme">
              {([['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const).map(([v, I, l]) => (
                <button key={v} type="button" role="radio" aria-checked={s.theme === v} onClick={() => set('theme', v)} className={cx('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[0.85rem]', s.theme === v ? 'bg-surface-3' : 'text-muted')}>
                  <I size={14} /> {l}
                </button>
              ))}
            </div>
          </Item>
          <Item label="Accent colour">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={s.accent === c} aria-label={c} onClick={() => set('accent', c)} className={cx('h-7 w-7 rounded-full border-2', s.accent === c ? 'border-fg' : 'border-transparent')} style={{ background: c }} />
              ))}
            </div>
          </Item>
          <Item label="Text size" htmlFor="font-scale">
            <input id="font-scale" type="range" min={0.9} max={1.3} step={0.05} value={s.fontScale} onChange={(e) => set('fontScale', Number(e.target.value))} className="w-36 accent-[var(--accent)]" />
            <span className="w-10 text-right text-[0.85rem] text-muted">{Math.round(s.fontScale * 100)}%</span>
          </Item>
          <Item label="Reduce motion" htmlFor="motion">
            <Select id="motion" value={s.reduceMotion} onChange={(e) => set('reduceMotion', e.target.value as Settings['reduceMotion'])}>
              <option value="system">Follow system</option>
              <option value="on">Always reduce</option>
              <option value="off">Allow animations</option>
            </Select>
          </Item>
        </Group>

        <Group title="Date and time" icon={<Sun size={16} />}>
          <Item label="Date format" htmlFor="date-order" hint="Also controls how Quick Add reads dates such as 03/04.">
            <Select id="date-order" value={s.dateOrder} onChange={(e) => set('dateOrder', e.target.value as Settings['dateOrder'])}>
              <option value="dmy">DD/MM/YYYY (UK)</option>
              <option value="mdy">MM/DD/YYYY (US)</option>
              <option value="ymd">YYYY-MM-DD (ISO)</option>
            </Select>
          </Item>
          <Item label="24-hour clock">
            <Switch checked={!s.hour12} onChange={(v) => set('hour12', !v)} label="24-hour clock" />
          </Item>
          <Item label="Week starts on" htmlFor="week-start">
            <Select id="week-start" value={s.weekStartsOn} onChange={(e) => set('weekStartsOn', Number(e.target.value) as 0 | 1)}>
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
            </Select>
          </Item>
          <Item label="Working hours" hint="Used by scheduling and workload features.">
            <input type="time" aria-label="Working day starts" value={s.workingHours.start} onChange={(e) => set('workingHours', { ...s.workingHours, start: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1" />
            –
            <input type="time" aria-label="Working day ends" value={s.workingHours.end} onChange={(e) => set('workingHours', { ...s.workingHours, end: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1" />
          </Item>
          <Item label="Default estimate" htmlFor="default-estimate" hint="Minutes assumed for tasks without an estimate when calculating workload.">
            <Select id="default-estimate" value={s.defaultEstimate} onChange={(e) => set('defaultEstimate', Number(e.target.value))}>
              {[0, 15, 30, 45, 60].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : 'Ignore unestimated tasks'}</option>)}
            </Select>
          </Item>
          <Item label="Working days">
            <div className="flex gap-1" role="group" aria-label="Working days">
              {WEEKDAY_SHORT.map((d, i) => {
                const on = s.workingHours.days.includes(i);
                return (
                  <button key={d} type="button" aria-pressed={on} onClick={() => set('workingHours', { ...s.workingHours, days: on ? s.workingHours.days.filter((x) => x !== i) : [...s.workingHours.days, i].sort() })} className={cx('h-8 w-9 rounded-md text-[0.8rem]', on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted')}>
                    {d.slice(0, 2)}
                  </button>
                );
              })}
            </div>
          </Item>
        </Group>

        <NotificationSettings />
        <CalendarSettings />
        <AddFromAssistantSettings />
        <LocalApiSettings />
        <AiSettings />
        <WebhookSettings />

        <Group title="Tasks" icon={<FlaskConical size={16} />}>
          <Item label="Complete a parent when all its subtasks are done" hint="Off by default: finishing subtasks doesn’t always mean the parent is finished.">
            <Switch checked={s.autoCompleteParent} onChange={(v) => set('autoCompleteParent', v)} label="Auto-complete parent tasks" />
          </Item>
          <Item label="Show completed tasks in projects">
            <Switch checked={s.showCompletedInProjects} onChange={(v) => set('showCompletedInProjects', v)} label="Show completed tasks in projects" />
          </Item>
          <Item label="Keyboard shortcuts">
            <Button size="sm" onClick={() => setShortcutsOpen(true)}>
              <Keyboard size={14} /> View
            </Button>
          </Item>
        </Group>

        <Group title="Data" icon={<Database size={16} />}>
          <Item label="Storage" hint={`${counts.tasks} tasks · ${(counts.bytes / 1024).toFixed(0)} KB database · stored on this device (${app.platform.persistence.name}), schema v${LATEST_SCHEMA_VERSION}`}>
            <span className="text-[0.8rem] text-muted">{lastBackup ? `Last backup ${new Date(lastBackup.created_at).toLocaleDateString('en-GB')}` : 'No backup yet'}</span>
          </Item>
          <Item label="Back up everything" hint="JSON includes attachments; SQLite is a byte-exact copy of the database.">
            <Button size="sm" onClick={() => void exportJson()}>
              <Download size={14} /> JSON
            </Button>
            <Button size="sm" onClick={() => void exportSqlite()}>
              <Download size={14} /> SQLite
            </Button>
          </Item>
          <Item label="Restore from backup" hint="Replaces all current data after you confirm. A safety copy of current data is kept.">
            <input ref={fileInput} type="file" accept=".json,.sqlite,.db,application/json" hidden onChange={(e) => void chooseImport(e.target.files?.[0])} aria-label="Choose a backup file" />
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              <Upload size={14} /> Choose file
            </Button>
          </Item>
          <TransferControls />
          <Item label="Demonstration data" hint={hasSample ? 'Removing it keeps any tasks you added yourself.' : 'Adds example projects, labels and tasks.'}>
            {hasSample ? (
              <Button size="sm" onClick={() => setConfirmRemoveSample(true)}>Remove</Button>
            ) : (
              <Button size="sm" onClick={() => act(() => app.data.loadSampleData(), { success: 'Demonstration data loaded' })}>Load</Button>
            )}
          </Item>
        </Group>
        <p className="mt-6 text-center text-[0.75rem] text-subtle">
          Focus {__APP_VERSION__} · runs entirely on this device · no account, no tracking
        </p>
      </ViewBody>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="Replace all data with this backup?"
        body={
          <>
            The backup contains <strong className="text-fg">{pending?.summary}</strong>. Everything currently in Focus will be replaced. A safety copy of your
            current data is kept on this device.
          </>
        }
        confirmLabel="Restore backup"
        danger
        onConfirm={() => void restore()}
      />
      <ConfirmDialog
        open={confirmRemoveSample}
        onClose={() => setConfirmRemoveSample(false)}
        title="Remove demonstration data?"
        body="Example projects, labels and tasks are deleted. Tasks you created yourself — even inside example projects — are kept and moved to the Inbox."
        confirmLabel="Remove"
        onConfirm={() => {
          const r = act(() => app.data.removeSampleData());
          if (r) pushToast({ message: r.rescued ? `Removed. ${r.rescued} of your own tasks were moved to the Inbox.` : 'Demonstration data removed', tone: 'success' });
        }}
      />
    </>
  );
}

function NotificationSettings() {
  const app = useApp();
  const s = useSettings();
  const set = useSetting();
  const pushToast = useUi((st) => st.pushToast);
  const [perm, setPerm] = useState<string>('…');
  useEffect(() => {
    void app.platform.notifications.permission().then(setPerm);
  }, [app]);
  const enable = async (on: boolean) => {
    if (on) {
      const p = await app.platform.notifications.requestPermission();
      setPerm(p);
      if (p !== 'granted') {
        pushToast({ message: p === 'unsupported' ? 'System notifications are not supported here; reminders still appear inside Focus.' : 'Notifications were not allowed. You can allow them in your browser or system settings.', tone: 'error' });
        return;
      }
    }
    set('notificationsEnabled', on);
  };
  const test = async () => {
    const ok = await app.platform.notifications.show({ id: 'test', title: 'Focus test notification', body: 'Notifications are working.' });
    pushToast({ message: ok ? 'Test notification sent' : 'Could not show a notification — check permissions', tone: ok ? 'success' : 'error' });
  };
  const permText: Record<string, string> = { granted: 'Allowed', denied: 'Blocked in system/browser settings', default: 'Not yet allowed', unsupported: 'Not supported here' };
  return (
    <Group title="Notifications" icon={<Bell size={16} />}>
      <Item label="System notifications for reminders" hint={`Permission: ${permText[perm] ?? perm}. Reminders always appear inside Focus while it is open.`}>
        <Switch checked={s.notificationsEnabled && perm === 'granted'} onChange={(v) => void enable(v)} label="System notifications for reminders" />
      </Item>
      <Item label="Send a test notification">
        <Button size="sm" disabled={perm !== 'granted'} onClick={() => void test()}>
          Test
        </Button>
      </Item>
      <Item
        label="When are reminders delivered?"
        hint="While Focus is open, or running in the background on desktop. If Focus was closed, missed reminders are shown together when you next open it. Delivery while the app is fully closed needs scheduled system notifications, which are not built yet (including on Android)."
      >
        <span />
      </Item>
    </Group>
  );
}
