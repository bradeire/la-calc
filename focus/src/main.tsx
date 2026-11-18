import { Component, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { boot, type BootResult } from './app/bootstrap';
import type { AppContainer } from './app/container';
import { createWebPlatform, isTauri } from './platform/web';
import { AppProvider } from './ui/hooks';
import { AppShell } from './ui/layout/AppShell';
import './index.css';

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-bg p-6 text-fg">
      <div className="max-w-md rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h1 className="text-[1.2rem] font-semibold">{title}</h1>
        <div className="mt-2 flex flex-col gap-3 text-[0.92rem] text-muted">{children}</div>
      </div>
    </div>
  );
}

const btn = 'h-10 rounded-lg px-4 font-medium';

/** Last-resort error screen. Still offers a data export so nothing is lost. */
class ErrorBoundary extends Component<{ app: AppContainer; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error('Unhandled UI error', error);
    void this.props.app.saver.flush();
  }
  override render() {
    if (!this.state.error) return this.props.children;
    const exportData = async () => {
      const json = JSON.stringify(await this.props.app.data.exportJson());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'focus-emergency-backup.json';
      a.click();
    };
    return (
      <Screen title="Something went wrong">
        <p>Focus hit an unexpected error. Your data is saved on this device.</p>
        <pre className="max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[0.75rem]">{this.state.error.message}</pre>
        <div className="flex gap-2">
          <button className={`${btn} bg-accent text-accent-fg`} onClick={() => window.location.reload()}>Reload</button>
          <button className={`${btn} border border-line`} onClick={() => void exportData()}>Export my data</button>
        </div>
      </Screen>
    );
  }
}

function Root({ initial }: { initial: BootResult }) {
  const [result, setResult] = useState(initial);
  const [busy, setBusy] = useState(false);
  switch (result.status) {
    case 'ready':
      return (
        <ErrorBoundary app={result.app}>
          <AppProvider app={result.app}>
            <AppShell />
          </AppProvider>
        </ErrorBoundary>
      );
    case 'locked':
      return (
        <Screen title="Focus is open in another tab">
          <p>To keep your data safe, Focus can only be open in one tab or window at a time. Close the other one, then reload this page.</p>
          <button className={`${btn} bg-accent text-accent-fg`} onClick={() => window.location.reload()}>Reload</button>
        </Screen>
      );
    case 'newer-schema':
      return (
        <Screen title="Please update Focus">
          <p>{result.message}</p>
        </Screen>
      );
    case 'corrupt':
      return (
        <Screen title="Your data needs attention">
          <p>The saved database failed its integrity check. A copy of it has been kept on this device and nothing has been deleted.</p>
          <pre className="max-h-24 overflow-auto rounded bg-surface-2 p-2 text-[0.75rem]">{result.details.join('\n')}</pre>
          {result.hasPrevious && (
            <button disabled={busy} className={`${btn} bg-accent text-accent-fg`} onClick={() => (setBusy(true), void result.recover().then(setResult))}>
              Restore the previous saved copy
            </button>
          )}
          <button disabled={busy} className={`${btn} border border-line`} onClick={() => (setBusy(true), void result.startFresh().then(setResult))}>
            Start with an empty database
          </button>
          <p className="text-[0.8rem]">You can then restore a backup from Settings → Data.</p>
        </Screen>
      );
    case 'error':
      return (
        <Screen title="Focus could not start">
          <p>{result.error.message}</p>
          <p className="text-[0.8rem]">If you are in a private browsing window, storage may be unavailable.</p>
          <button className={`${btn} bg-accent text-accent-fg`} onClick={() => window.location.reload()}>Try again</button>
        </Screen>
      );
  }
}

async function main() {
  const rootEl = document.getElementById('root')!;
  const root = createRoot(rootEl);
  let result: BootResult;
  try {
    const sql = await initSqlJs({ locateFile: () => wasmUrl });
    // The native adapter is loaded only inside the Tauri shell, keeping it out of the web path.
    const platform = isTauri() ? (await import('./platform/tauri')).createTauriPlatform() : createWebPlatform();
    result = await boot(sql, platform);
  } catch (err) {
    result = { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
  root.render(
    <StrictMode>
      <Root initial={result} />
    </StrictMode>,
  );
  document.getElementById('boot-splash')?.remove();

  // The installable web app (PWA) was dropped in 0.9.0: remove the offline cache an earlier version installed.
  if ('serviceWorker' in navigator && !isTauri()) {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister())).catch(() => {});
  }
}

void main();
