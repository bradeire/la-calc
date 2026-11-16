import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Globe, House, LoaderCircle, Sparkles } from 'lucide-react';
import { isLocalUrl, type ChatMessage } from '@/services/ai-service';
import { errorMessage, useApp } from '../hooks';
import { go } from '../router';
import { Button, Dialog } from '../primitives';

/**
 * Every AI request goes through this dialog: it shows where the data goes and
 * exactly what will be sent, and only sends when the user presses Send.
 * Results are rendered by the caller as suggestions to accept or ignore.
 */
export function AiDialog<T>({
  open,
  onClose,
  title,
  messages,
  run,
  render,
  autoSend,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  messages: () => ChatMessage[];
  run: () => Promise<T>;
  render: (result: T, close: () => void) => ReactNode;
  autoSend?: boolean;
}) {
  const app = useApp();
  const [state, setState] = useState<{ phase: 'idle' | 'sending' | 'done' | 'error'; result?: T; error?: string }>({ phase: 'idle' });
  const [showPayload, setShowPayload] = useState(false);
  const unavailable = open ? app.ai.unavailableReason() : null;
  const cfg = app.ai.config();
  const local = isLocalUrl(cfg.baseUrl);
  let preview = '';
  if (open && !unavailable) {
    try {
      preview = messages().filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    } catch (err) {
      preview = errorMessage(err);
    }
  }
  const send = async () => {
    setState({ phase: 'sending' });
    try {
      setState({ phase: 'done', result: await run() });
    } catch (err) {
      setState({ phase: 'error', error: errorMessage(err) });
    }
  };
  useEffect(() => {
    if (!open) setState({ phase: 'idle' });
    else if (autoSend && !unavailable && state.phase === 'idle') void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => {
    setState({ phase: 'idle' });
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={title} size="lg">
      <div className="flex flex-col gap-3 p-4">
        {unavailable ? (
          <>
            <p className="text-[0.92rem] text-muted">{unavailable}</p>
            <Button className="self-start" onClick={() => (close(), go({ name: 'settings' }))}>
              Open AI settings
            </Button>
          </>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-[0.82rem] text-muted">
              {local ? <House size={14} className="text-ok" /> : <Globe size={14} className="text-warn" />}
              {local ? 'Sent to a model on your computer or network' : 'Sent over the internet'}: {cfg.baseUrl} · {cfg.model}
            </p>
            <button type="button" onClick={() => setShowPayload(!showPayload)} aria-expanded={showPayload} className="flex items-center gap-1 self-start text-[0.82rem] text-muted hover:text-fg">
              <ChevronRight size={13} className={showPayload ? 'rotate-90' : ''} /> What will be sent
            </button>
            {showPayload && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2.5 text-[0.75rem]">{preview}</pre>}
            {state.phase === 'idle' && (
              <Button variant="primary" className="self-start" onClick={() => void send()}>
                <Sparkles size={14} /> Send
              </Button>
            )}
            {state.phase === 'sending' && (
              <p className="flex items-center gap-2 text-[0.88rem] text-muted" role="status">
                <LoaderCircle size={15} className="animate-spin" /> Waiting for the model…
              </p>
            )}
            {state.phase === 'error' && (
              <div className="flex flex-col gap-2">
                <p role="alert" className="text-[0.88rem] text-danger">{state.error}</p>
                <Button className="self-start" onClick={() => void send()}>
                  Try again
                </Button>
              </div>
            )}
            {state.phase === 'done' && state.result !== undefined && render(state.result, close)}
          </>
        )}
      </div>
    </Dialog>
  );
}
