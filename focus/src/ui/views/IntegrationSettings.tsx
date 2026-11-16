import { useState, type ReactNode } from 'react';
import { Bot, CalendarPlus, Copy, Download, FileUp, Link2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Webhook } from 'lucide-react';
import { PALETTE } from '@/core/domain/types';
import { saveFile } from '../download';
import { ASSISTANT_INSTRUCTIONS, buildAddLink } from '@/core/links';
import { isLocalUrl, type AiConfig } from '@/services/ai-service';
import { useUi } from '@/state/ui-store';
import { errorMessage, useAction, useApp, useQuery } from '../hooks';
import { Button, Dialog, Field, IconButton, Input, Select, Switch } from '../primitives';

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-[0.95rem] font-semibold">
        <span className="text-muted">{icon}</span>
        {title}
      </h2>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface">{children}</div>
    </section>
  );
}

function WebhookDialog({ id, onClose }: { id: string | null | undefined; onClose: () => void }) {
  const app = useApp();
  const existing = useQuery(() => (id ? app.webhooks.list().find((w) => w.id === id) : undefined), [id]);
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await app.webhooks.save({ id: id ?? undefined, name, url, secret: secret ? secret : undefined });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={id !== undefined}
      onClose={onClose}
      title={id ? 'Edit webhook' : 'Add webhook'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !url.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <Field label="Name" htmlFor="wh-name">
          <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home Assistant" />
        </Field>
        <Field label="URL" htmlFor="wh-url" hint="Home Assistant: http://homeassistant.local:8123/api/webhook/<your-webhook-id>">
          <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
        </Field>
        <Field
          label={existing?.signed ? 'Signing secret (leave blank to keep the current one)' : 'Signing secret (optional)'}
          htmlFor="wh-secret"
          hint={`Requests carry X-Focus-Signature: sha256=<HMAC of the body>. ${app.platform.secrets.persistent ? 'Stored in your system keychain.' : 'In the browser it is kept for this session only.'}`}
        >
          <Input id="wh-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <p className="text-[0.8rem] text-muted">Webhooks send only the task’s title, status, priority, project and dates — never descriptions, comments or files.</p>
        {error && <p role="alert" className="text-[0.85rem] text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

export function WebhookSettings() {
  const app = useApp();
  const act = useAction();
  const pushToast = useUi((s) => s.pushToast);
  const hooks = useQuery(() => app.webhooks.list(), []);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const test = async (id: string) => {
    try {
      const r = await app.webhooks.test(id);
      pushToast({ message: `Webhook answered ${r.status}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <Group title="Webhooks and Home Assistant" icon={<Webhook size={16} />}>
      {hooks.map((w) => (
        <div key={w.id} className="flex items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.93rem]">
              {w.name} {w.signed && <ShieldCheck size={13} className="inline text-ok" aria-label="Signed" />}
            </div>
            <div className="truncate text-[0.78rem] text-muted">{w.url}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void test(w.id)}>
            Test
          </Button>
          <IconButton size="sm" label={`Edit ${w.name}`} onClick={() => setEditing(w.id)}>
            <Pencil size={14} />
          </IconButton>
          <IconButton size="sm" label={`Delete ${w.name}`} onClick={() => act(() => app.webhooks.remove(w.id))}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className="max-w-md text-[0.8rem] text-muted">
          Use webhooks in Automations (“Call a webhook”) to tell Home Assistant, Zapier or IFTTT when tasks change. Creating tasks <em>from</em> Home Assistant needs Focus’s local API, planned for a later update.
        </p>
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus size={14} /> Add webhook
        </Button>
      </div>
      {editing !== undefined && <WebhookDialog id={editing} onClose={() => setEditing(undefined)} />}
    </Group>
  );
}

export function AiSettings() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const cfg = useQuery(() => app.ai.config(), []);
  const [draft, setDraft] = useState<AiConfig>(cfg);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const consented = cfg.consentUrl === cfg.baseUrl && !!cfg.consentAt;
  const local = isLocalUrl(draft.baseUrl);
  const dirty = JSON.stringify({ ...draft, consentUrl: null, consentAt: null }) !== JSON.stringify({ ...cfg, consentUrl: null, consentAt: null }) || !!key;
  const save = async () => {
    try {
      // Consent is managed only by its own buttons; the form must never overwrite it.
      const { consentUrl: _consentUrl, consentAt: _consentAt, ...fields } = draft;
      const next = await app.ai.saveConfig(fields, key ? key : undefined);
      setDraft(next);
      setKey('');
      pushToast({ message: 'AI settings saved', tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const testConnection = async () => {
    setBusy(true);
    try {
      await app.ai.chat([{ role: 'user', content: 'Reply with {"ok":true}' }]);
      pushToast({ message: 'The AI provider answered correctly', tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="AI assistant (optional)" icon={<Bot size={16} />}>
      <div className="flex flex-col gap-4 px-4 py-3">
        <label className="flex items-center justify-between gap-3 text-[0.93rem]">
          <span>
            Use an AI assistant
            <span className="block text-[0.8rem] text-muted">Off by default. Focus works fully without it. Suggestions never change tasks until you accept them.</span>
          </span>
          <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Use an AI assistant" />
        </label>
        {draft.enabled && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider" htmlFor="ai-provider">
                <Select
                  id="ai-provider"
                  value={draft.provider}
                  onChange={(e) => {
                    const provider = e.target.value as AiConfig['provider'];
                    setDraft({ ...draft, provider, baseUrl: provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1', model: provider === 'ollama' ? 'llama3.1' : 'gpt-4o-mini' });
                  }}
                >
                  <option value="ollama">Ollama (runs on your computer)</option>
                  <option value="openai">OpenAI-compatible API (LM Studio, OpenAI, others)</option>
                </Select>
              </Field>
              <Field label="Model" htmlFor="ai-model">
                <Input id="ai-model" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </Field>
            </div>
            <Field label="Server address" htmlFor="ai-url" hint={local ? 'This address is on your computer or local network.' : 'This address is on the internet: task data you send will leave your network.'}>
              <Input id="ai-url" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} inputMode="url" />
            </Field>
            {draft.provider === 'openai' && (
              <Field label="API key" htmlFor="ai-key" hint={app.platform.secrets.persistent ? 'Stored in your system keychain, never in Focus’s database.' : 'In the browser the key is kept for this session only and must be re-entered after restarting.'}>
                <Input id="ai-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Leave blank to keep the current key" />
              </Field>
            )}
            <label className="flex items-center justify-between gap-3 text-[0.9rem]">
              <span>
                Include task descriptions
                <span className="block text-[0.8rem] text-muted">Titles, dates, priorities and project names are sent; descriptions only if you allow it. Comments and files are never sent.</span>
              </span>
              <Switch checked={draft.sendDescriptions} onChange={(v) => setDraft({ ...draft, sendDescriptions: v })} label="Include task descriptions" />
            </label>
            {app.platform.kind === 'web' && draft.provider === 'ollama' && (
              <p className="text-[0.8rem] text-muted">In the browser, Ollama must allow this page’s address (set OLLAMA_ORIGINS). The desktop app does not need this.</p>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
          {cfg.enabled && !consented && (
            <Button size="sm" onClick={() => void app.ai.giveConsent().then(() => pushToast({ message: 'Consent recorded', tone: 'success' }))}>
              <ShieldCheck size={14} /> I agree to send task data to {cfg.baseUrl}
            </Button>
          )}
          {cfg.enabled && consented && (
            <>
              <span className="text-[0.8rem] text-ok">Consent given {new Date(cfg.consentAt!).toLocaleDateString('en-GB')}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void testConnection()}>
                {busy ? 'Testing…' : 'Test connection'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void app.ai.saveConfig({ consentUrl: null, consentAt: null })}>
                Withdraw consent
              </Button>
            </>
          )}
        </div>
      </div>
    </Group>
  );
}

/** Tap-to-add links: instructions for Claude (or any assistant) to reply with focus:// links. */
export function AddFromAssistantSettings() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const native = app.platform.kind === 'tauri';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ASSISTANT_INSTRUCTIONS);
      pushToast({ message: 'Instructions copied', tone: 'success' });
    } catch {
      pushToast({ message: 'Could not copy: select the text and copy it instead', tone: 'error' });
    }
  };
  return (
    <Group title="Add tasks from Claude" icon={<Link2 size={16} />}>
      <div className="flex flex-col gap-3 px-4 py-3 text-[0.93rem]">
        <p>
          Ask Claude (or another assistant) for tasks and it can reply with links. Tapping one opens Quick Add already
          filled in; nothing is added until you press Add. Nothing is sent anywhere: the link carries the text to Focus.
        </p>
        <p className="text-[0.85rem] text-muted">
          Paste these instructions into Claude once (Settings → Profile → personal preferences, or a project’s
          instructions). On Android you can also share any Claude reply to Focus to pick tasks from it.
        </p>
        <textarea
          readOnly
          aria-label="Instructions for Claude"
          value={ASSISTANT_INSTRUCTIONS}
          onFocus={(e) => e.currentTarget.select()}
          rows={7}
          className="w-full resize-y rounded-lg border border-line bg-surface-2 p-2 font-mono text-[0.78rem] leading-snug"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={copy}>
            <Copy size={14} /> Copy instructions
          </Button>
          {native ? (
            <a className="text-[0.85rem] text-accent underline" href={buildAddLink('Try a Focus link tomorrow 9am p3')}>
              Test a link
            </a>
          ) : (
            <span className="text-[0.8rem] text-muted">Links open the installed Focus app (Android or desktop), not this browser tab.</span>
          )}
        </div>
      </div>
    </Group>
  );
}

const CALENDAR_HELP = [
  ['Google Calendar', 'calendar.google.com → Settings → (your calendar) → Integrate calendar → “Secret address in iCal format”.'],
  ['Outlook / Microsoft 365', 'outlook.com → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link.'],
  ['Apple iCloud', 'Calendar app → share a calendar → Public Calendar → copy the webcal:// link.'],
] as const;

function AddCalendarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState(PALETTE[5]!.value);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await app.calendars.addUrl({ name, url, color });
      pushToast({ message: 'Calendar added', tone: 'success' });
      setName('');
      setUrl('');
      onClose();
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a calendar"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!url.trim() || busy} onClick={save}>
            {busy ? 'Checking…' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <Field label="Name" htmlFor="cal-name">
          <Input id="cal-name" value={name} placeholder="e.g. Family" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Private calendar address (.ics)" htmlFor="cal-url" hint="Anyone with this address can read the calendar, so Focus keeps it in secure storage, not in its database.">
          <Input id="cal-url" value={url} placeholder="https://… or webcal://…" onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Colour" htmlFor="cal-color">
          <Select id="cal-color" value={color} onChange={(e) => setColor(e.target.value)}>
            {PALETTE.map((p) => (
              <option key={p.value} value={p.value}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <details className="text-[0.82rem] text-muted">
          <summary className="cursor-pointer">Where do I find the address?</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {CALENDAR_HELP.map(([k, v]) => (
              <li key={k}>
                <strong className="text-fg">{k}:</strong> {v}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Dialog>
  );
}

/** External calendars (spec 6.4): read-only display, availability, and task export. */
export function CalendarSettings() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const sources = useQuery(() => app.calendars.sources(), []);
  const projects = useQuery(() => app.repos.projects.list(), []);
  const [adding, setAdding] = useState(false);
  const [exportProject, setExportProject] = useState('');
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const refresh = async (id: string) => {
    setRefreshing(id);
    try {
      const n = await app.calendars.refresh(id);
      pushToast({ message: `Updated: ${n} event${n === 1 ? '' : 's'}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setRefreshing(null);
    }
  };
  const reenter = async (id: string) => {
    const url = window.prompt('Paste the calendar’s private address again');
    if (!url) return;
    try {
      await app.calendars.setAddress(id, url);
      pushToast({ message: 'Calendar updated', tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      app.calendars.addFile({ name: file.name.replace(/\.ics$/i, ''), text, color: PALETTE[9]!.value });
      pushToast({ message: `Imported “${file.name}”`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const exportIcs = async () => {
    try {
      const r = app.calendars.exportIcs({ projectId: exportProject || null });
      if (!r.count) {
        pushToast({ message: 'No scheduled tasks to export', tone: 'error' });
        return;
      }
      const where = await saveFile(app.platform, r.filename, r.text, 'text/calendar');
      pushToast({ message: `Exported ${r.count} task${r.count === 1 ? '' : 's'}${where ? `. ${where}` : ''}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <Group title="Calendars" icon={<CalendarPlus size={16} />}>
      <div className="flex flex-col gap-3 px-4 py-3 text-[0.9rem]">
        <p className="text-[0.85rem] text-muted">
          Show events from Google, Outlook or Apple calendars next to your tasks (read-only). Events can count as busy time, so workload and
          suggested rescheduling avoid them. Focus’s own calendar works without any of this.
        </p>
        {sources.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Calendars">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  {s.kind === 'url' && (
                    <IconButton size="sm" label={`Refresh ${s.name}`} disabled={refreshing === s.id} onClick={() => refresh(s.id)}>
                      <RefreshCw size={14} className={refreshing === s.id ? 'animate-spin' : ''} />
                    </IconButton>
                  )}
                  <IconButton
                    size="sm"
                    label={`Remove ${s.name}`}
                    onClick={() => askConfirm({ message: `Remove “${s.name}”? Its events disappear from Focus; the calendar itself is not changed.`, confirmLabel: 'Remove', onConfirm: () => void app.calendars.remove(s.id) })}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
                <p className="text-[0.8rem] text-muted">
                  {s.kind === 'file' ? 'Imported file' : 'Subscribed'} · {s.eventCount} event{s.eventCount === 1 ? '' : 's'}
                  {s.lastSyncedAt && ` · updated ${new Date(s.lastSyncedAt).toLocaleString()}`}
                </p>
                {s.lastError && (
                  <p role="status" className="flex flex-wrap items-center gap-2 text-[0.8rem] text-danger">
                    {s.lastError}
                    {/again|needed/i.test(s.lastError) && (
                      <Button size="sm" onClick={() => reenter(s.id)}>
                        Enter address
                      </Button>
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2 text-[0.85rem]">
                    <Switch checked={s.visible} onChange={(v) => app.calendars.update(s.id, { visible: v })} label={`Show ${s.name} in the calendar`} />
                    Show in calendar
                  </label>
                  <label className="flex items-center gap-2 text-[0.85rem]">
                    <Switch checked={s.blocksTime} onChange={(v) => app.calendars.update(s.id, { blocksTime: v })} label={`Count ${s.name} as busy time`} />
                    Count as busy time
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add calendar by address
          </Button>
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-[0.86rem] font-medium hover:bg-surface-3 focus-within:ring-2 focus-within:ring-accent">
            <FileUp size={14} /> Import .ics file
            <input type="file" accept=".ics,text/calendar" className="sr-only" onChange={(e) => (void importFile(e.target.files?.[0]), (e.target.value = ''))} />
          </label>
        </div>
        {app.platform.kind === 'web' && (
          <p className="text-[0.8rem] text-muted">
            In the browser, most calendar servers block direct access and addresses are only remembered until you close the tab. The desktop and
            Android apps don’t have these limits; importing an .ics file works everywhere.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Export scheduled tasks as a calendar file" htmlFor="ics-export">
            <Select id="ics-export" value={exportProject} onChange={(e) => setExportProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button size="sm" onClick={() => void exportIcs()}>
            <Download size={14} /> Export .ics
          </Button>
        </div>
      </div>
      <AddCalendarDialog open={adding} onClose={() => setAdding(false)} />
    </Group>
  );
}
