import { useRef, useState } from 'react';
import { ArrowRight, Database, FileUp, Monitor, Moon, Sparkles, Sun, Target } from 'lucide-react';
import type { Settings } from '@/data/repositories/settings';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useSettings } from '../hooks';
import { Button, Select, cx } from '../primitives';

/** First-run: choose a starting point, then a few preferences. No registration. */
export function Onboarding() {
  const app = useApp();
  const s = useSettings();
  const pushToast = useUi((st) => st.pushToast);
  const [step, setStep] = useState<0 | 1>(0);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => app.repos.settings.set(k, v);

  const start = (choice: 'empty' | 'demo') => {
    try {
      if (choice === 'demo' && !app.data.hasSampleData()) app.data.loadSampleData();
      setStep(1);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const { backup } = app.data.inspectJson(await f.text());
      await app.data.restoreJson(backup);
      app.repos.settings.set('onboarded', true);
      pushToast({ message: 'Backup imported', tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="pt-safe pb-safe flex min-h-[100dvh] items-center justify-center bg-bg px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <Target size={22} strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-[1.5rem] font-bold tracking-tight">Welcome to Focus</h1>
            <p className="text-[0.88rem] text-muted">Your tasks stay on this device. No account needed.</p>
          </div>
        </div>
        {step === 0 ? (
          <div className="flex flex-col gap-2.5">
            <Choice icon={<Sparkles size={20} />} title="Start fresh" body="An empty Inbox, ready for your tasks." onClick={() => start('empty')} />
            <Choice icon={<Database size={20} />} title="Explore with demonstration data" body="Example projects and tasks. Remove them any time in Settings." onClick={() => start('demo')} />
            <Choice icon={<FileUp size={20} />} title="Import a Focus backup" body="Restore a JSON backup exported from Focus." onClick={() => file.current?.click()} />
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void importFile(e.target.files?.[0])} aria-label="Choose a backup file" />
            {error && <p role="alert" className="text-[0.85rem] text-danger">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="mb-2 text-[0.9rem] font-semibold">Theme</h2>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                {([['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const).map(([v, I, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={s.theme === v} onClick={() => set('theme', v)} className={cx('flex flex-col items-center gap-1 rounded-xl border py-3 text-[0.85rem]', s.theme === v ? 'border-accent bg-surface' : 'border-line text-muted')}>
                    <I size={18} /> {l}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 text-[0.92rem]">
              Date format
              <Select value={s.dateOrder} onChange={(e) => set('dateOrder', e.target.value as Settings['dateOrder'])}>
                <option value="dmy">DD/MM/YYYY</option>
                <option value="mdy">MM/DD/YYYY</option>
                <option value="ymd">YYYY-MM-DD</option>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-3 text-[0.92rem]">
              Clock
              <Select value={s.hour12 ? '12' : '24'} onChange={(e) => set('hour12', e.target.value === '12')}>
                <option value="24">24-hour</option>
                <option value="12">12-hour</option>
              </Select>
            </label>
            <div className="flex items-center justify-between gap-3 text-[0.92rem]">
              Working hours
              <span className="flex items-center gap-1">
                <input type="time" aria-label="Start" value={s.workingHours.start} onChange={(e) => set('workingHours', { ...s.workingHours, start: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1" />
                –
                <input type="time" aria-label="End" value={s.workingHours.end} onChange={(e) => set('workingHours', { ...s.workingHours, end: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-1" />
              </span>
            </div>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[0.82rem] text-muted">
              Notifications: reminders can be added to tasks now; delivering them as system notifications is not enabled in this version yet.
            </p>
            <Button variant="primary" className="h-11" onClick={() => set('onboarded', true)}>
              Get started <ArrowRight size={16} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Choice({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left shadow-card transition-colors hover:border-accent">
      <span className="mt-0.5 text-accent">{icon}</span>
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-[0.85rem] text-muted">{body}</span>
      </span>
    </button>
  );
}
