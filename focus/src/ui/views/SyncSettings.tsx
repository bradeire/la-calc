import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, KeyRound, RefreshCw, RefreshCcw, ShieldCheck } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { buildSyncLink } from '@/core/links';
import type { SyncStatus } from '@/services/sync-service';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useQuery } from '../hooks';
import { Button, Dialog, Field, Input, Switch } from '../primitives';

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-[0.95rem] font-semibold">
        <span className="text-muted">{icon}</span>
        {title}
      </h2>
      <div className="rounded-xl border border-line bg-surface">{children}</div>
    </section>
  );
}

import relayCode from '../../../tools/focus-sync-relay/worker.js?raw';
import { saveFile } from '../download';

/** Setting up the relay on a free Cloudflare account (dashboard only; no command line). */
function RelayGuide() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(relayCode);
      pushToast({ message: 'Relay code copied', tone: 'success' });
    } catch {
      pushToast({ message: 'Could not copy', tone: 'error' });
    }
  };
  return (
    <details className="text-[0.85rem]">
      <summary className="cursor-pointer text-accent">How to set up your relay (about 5 minutes, free)</summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-muted">
        <li>Create a free account at dash.cloudflare.com (no card needed for the free plan).</li>
        <li>Storage &amp; Databases → D1 → Create database, name it <code>focus-sync</code>.</li>
        <li>Workers &amp; Pages → Create → Worker → name it <code>focus-sync</code> → Deploy.</li>
        <li>
          Edit code → replace everything with the relay code → Deploy.{' '}
          <span className="inline-flex gap-1">
            <Button size="sm" onClick={() => void copy()}>
              <Copy size={13} /> Copy relay code
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void saveFile(app.platform, 'worker.js', relayCode, 'text/javascript').then((w) => w && pushToast({ message: w, tone: 'success' }))}>
              Save worker.js
            </Button>
          </span>
        </li>
        <li>The worker’s Settings → Bindings → Add → D1 database: variable name <code>DB</code>, database <code>focus-sync</code> → Save.</li>
        <li>
          Copy the worker’s address (<code>https://focus-sync.&lt;you&gt;.workers.dev</code>) into “Relay address” here. Opening <code>/v1/health</code> on it should show{' '}
          <code>{'{"ok":true}'}</code>.
        </li>
      </ol>
      <p className="mt-2 text-[0.8rem] text-muted">Cloudflare’s menus move around occasionally; the names above may differ slightly.</p>
    </details>
  );
}

/** QR code as an inline SVG (black on white regardless of theme, so phone cameras can read it). */
function Qr({ text, label }: { text: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }, [text]);
  return <div role="img" aria-label={label} className="w-56 max-w-full rounded-lg bg-white p-1" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function JoinDetails({ relay, syncKey }: { relay: string; syncKey: string }) {
  const pushToast = useUi((s) => s.pushToast);
  const link = buildSyncLink(relay, syncKey);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ message: `${what} copied`, tone: 'success' });
    } catch {
      pushToast({ message: 'Could not copy', tone: 'error' });
    }
  };
  return (
    <div className="flex flex-col gap-3 text-[0.88rem]">
      <p>
        On your other device, open Focus → Settings → Sync between devices → <strong>Join from another device</strong>. Or scan this code with the phone’s camera:
        most camera apps offer to open it in Focus with the details filled in. If yours doesn’t, copy the join link to the phone and tap it.
      </p>
      <Qr text={link} label="QR code to join sync from another device" />
      <div>
        <div className="text-muted">Relay</div>
        <code className="break-all">{relay}</code>
      </div>
      <div>
        <div className="text-muted">Sync key</div>
        <code className="break-all font-semibold tracking-wide">{syncKey}</code>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copy(syncKey, 'Sync key')}>
          <Copy size={14} /> Copy key
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy(link, 'Join link')}>
          <Copy size={14} /> Copy join link
        </Button>
      </div>
      <p className="text-[0.8rem] text-muted">
        Treat the key like a password: anyone with it and the relay address can read your tasks. Keep a copy somewhere safe (e.g. a password manager) — without it,
        a new device can’t join.
      </p>
    </div>
  );
}

function SetUpDialog({ mode, onClose, prefill }: { mode: 'create' | 'join' | null; onClose: () => void; prefill?: { relay: string; key: string } | null }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const [relay, setRelay] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    if (!mode) return;
    setRelay(prefill?.relay ?? '');
    setKey(prefill?.key ?? '');
    setCreated(null);
  }, [mode, prefill]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await app.sync.enable({ relayUrl: relay, key: mode === 'join' ? key : undefined });
      if (mode === 'create') setCreated(r.key);
      else {
        pushToast({ message: 'Joined: this device is now in sync', tone: 'success' });
        onClose();
      }
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!mode}
      onClose={onClose}
      title={mode === 'join' ? 'Join sync' : 'Set up sync'}
      footer={
        created ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !relay.trim() || (mode === 'join' && !key.trim())} onClick={() => void go()}>
              {busy ? 'Connecting…' : mode === 'join' ? 'Join' : 'Create sync key'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[0.9rem]">
        {created ? (
          <>
            <p className="flex items-center gap-2 font-medium text-ok">
              <ShieldCheck size={16} /> Sync is on for this device.
            </p>
            <JoinDetails relay={relay.trim().replace(/\/+$/, '')} syncKey={created} />
          </>
        ) : (
          <>
            {mode === 'join' && prefill && <p className="rounded-lg bg-surface-2 p-2 text-[0.85rem]">A join link was opened. Check the relay is yours before joining.</p>}
            <Field label="Relay address" htmlFor="sync-relay" hint="Your own relay on a free Cloudflare account. It only ever stores encrypted data.">
              <Input id="sync-relay" value={relay} placeholder="https://focus-sync.your-name.workers.dev" autoComplete="off" spellCheck={false} onChange={(e) => setRelay(e.target.value)} />
            </Field>
            {mode === 'join' && (
              <Field label="Sync key (from your other device)" htmlFor="sync-key">
                <Input id="sync-key" value={key} placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
              </Field>
            )}
            {mode === 'create' && (
              <p className="text-[0.85rem] text-muted">Focus creates a new random sync key on this device. Your data is encrypted with it before it leaves the device.</p>
            )}
            <RelayGuide />
          </>
        )}
      </div>
    </Dialog>
  );
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

/** Sync between devices (end-to-end encrypted, via the user's own relay). */
export function SyncSettings() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const syncJoin = useUi((s) => s.syncJoin);
  const setSyncJoin = useUi((s) => s.setSyncJoin);
  const [tick, setTick] = useState(0);
  const status: SyncStatus = useQuery(() => app.sync.status(), [tick]);
  const [mode, setMode] = useState<'create' | 'join' | null>(null);
  const [details, setDetails] = useState<{ relay: string; key: string } | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [reKey, setReKey] = useState('');
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    void app.sync.getKey().then((k) => setHasKey(!!k));
  }, [app, status.enabled, tick]);
  useEffect(() => {
    if (syncJoin && !status.enabled) setMode('join');
    else if (syncJoin && status.enabled) {
      pushToast({ message: 'This device already syncs. Turn sync off first to join a different one.', tone: 'error' });
      setSyncJoin(null);
    }
  }, [syncJoin, status.enabled, pushToast, setSyncJoin]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) pushToast({ message: ok, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
    setTick((t) => t + 1);
  };
  const closeDialog = () => {
    setMode(null);
    setSyncJoin(null);
    setTick((t) => t + 1);
  };

  return (
    <Group title="Sync between devices" icon={<RefreshCcw size={16} />}>
      <div className="flex flex-col gap-3 px-4 py-3 text-[0.9rem]">
        {!status.enabled ? (
          <>
            <p>
              Keep tasks, projects, notes, comments, labels, filters, templates and automations the same on your phone and computer. Everything is encrypted
              on the device before it’s sent, through a relay on your own free Cloudflare account; the relay can’t read it.
            </p>
            <p className="text-[0.8rem] text-muted">Not synced: attachment files, external calendars, webhooks and AI settings (set those up on each device).</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setMode('create')}>
                Set up on this device
              </Button>
              <Button size="sm" onClick={() => setMode('join')}>
                Join from another device
              </Button>
            </div>
          </>
        ) : (
          <>
            <p role="status" className={status.lastError ? 'text-danger' : 'text-muted'}>
              {status.syncing ? 'Syncing…' : status.lastError ? status.lastError : `Synced ${ago(status.lastSyncAt)}`}
              {status.pending > 0 && ` · ${status.pending} change${status.pending === 1 ? '' : 's'} to send`}
              {status.waiting > 0 && ` · ${status.waiting} waiting for related items`}
            </p>
            {!hasKey && (
              <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 p-2">
                <Field label="This device needs the sync key again" htmlFor="sync-rekey">
                  <Input id="sync-rekey" value={reKey} placeholder="XXXX-XXXX-…" onChange={(e) => setReKey(e.target.value)} />
                </Field>
                <Button size="sm" disabled={!reKey.trim()} onClick={() => void act(() => app.sync.setKey(reKey), 'Sync resumed')}>
                  <KeyRound size={14} /> Use key
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={status.syncing || !hasKey} onClick={() => void act(() => app.sync.syncNow(), 'Synced')}>
                <RefreshCw size={14} className={status.syncing ? 'animate-spin' : ''} /> Sync now
              </Button>
              <Button size="sm" variant="ghost" disabled={!hasKey} onClick={() => void app.sync.joinDetails().then(setDetails)}>
                Add another device
              </Button>
            </div>
            <label className="flex items-center justify-between gap-3 text-[0.88rem]">
              <span>
                Run time-based automations on this device
                <span className="block text-[0.8rem] text-muted">Overdue alerts, deadline reminders and similar run on one device, so they don’t happen twice.</span>
              </span>
              <Switch checked={status.runsTimedAutomations} onChange={(v) => (app.sync.setRunsTimedAutomations(v), setTick((t) => t + 1))} label="Run time-based automations on this device" />
            </label>
            <details className="text-[0.85rem]">
              <summary className="cursor-pointer text-muted">Turn off</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => askConfirm({ message: 'Stop syncing on this device? Its data stays here; other devices keep syncing with each other.', confirmLabel: 'Turn off', onConfirm: () => void act(() => app.sync.disable(), 'Sync turned off on this device') })}
                >
                  Turn off on this device
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    askConfirm({
                      message: 'Erase all your synced data from the relay and turn sync off here? Each device keeps its own copy, but they stop syncing.',
                      confirmLabel: 'Erase',
                      onConfirm: () => void act(() => app.sync.eraseRelayData(), 'Relay data erased'),
                    })
                  }
                >
                  Erase data from the relay
                </Button>
              </div>
            </details>
          </>
        )}
      </div>
      <SetUpDialog mode={mode} onClose={closeDialog} prefill={syncJoin} />
      <Dialog open={!!details} onClose={() => setDetails(null)} title="Add another device" footer={<Button variant="primary" onClick={() => setDetails(null)}>Done</Button>}>
        <div className="p-4">{details && <JoinDetails relay={details.relay} syncKey={details.key} />}</div>
      </Dialog>
    </Group>
  );
}
