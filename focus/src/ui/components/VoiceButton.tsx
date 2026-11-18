import { useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { installOnDevice, listen, supportsOnDeviceProbe, voiceMode, type ListenHandle, type VoiceMode } from '@/platform/voice';
import { useApp } from '../hooks';
import { useUi } from '@/state/ui-store';
import { Button, ConfirmDialog, IconButton, cx } from '../primitives';

const LANG = 'en-GB';
const ONLINE_OK_KEY = 'focus.ui.voiceOnlineOk';
const ON_DEVICE_KEY = 'focus.ui.voiceOnDevice';

const pref = (k: string) => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const setPref = (k: string) => {
  try {
    localStorage.setItem(k, '1');
  } catch {
    // not remembered; we will ask again next time
  }
};

/** Dictate into Quick Add (spec 5.2). Explains on-device vs online recognition before first use. */
export function VoiceButton({ onText }: { onText: (text: string, isFinal: boolean) => void }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const [listening, setListening] = useState(false);
  const [ask, setAsk] = useState<VoiceMode | null>(null);
  const handle = useRef<ListenHandle | null>(null);

  const start = (onDevice: boolean) => {
    try {
      handle.current = listen({
        lang: LANG,
        onDevice,
        onText,
        onError: (m) => pushToast({ message: m, tone: 'error' }),
        onEnd: () => setListening(false),
      });
      setListening(true);
    } catch (err) {
      pushToast({ message: (err as Error).message, tone: 'error' });
    }
  };

  /** Opt-in: probe and use on-device recognition. Data is saved first because the probe is experimental. */
  const tryOnDevice = async () => {
    await app.saver.flush(true);
    const mode = await voiceMode(LANG, { probeOnDevice: true });
    if (mode.kind === 'on-device') {
      setPref(ON_DEVICE_KEY);
      start(true);
    } else setAsk(mode.kind === 'on-device-downloadable' ? mode : { kind: 'online' });
  };

  const click = async () => {
    if (listening) {
      handle.current?.stop();
      return;
    }
    const mode = await voiceMode(LANG);
    if (mode.kind === 'unsupported') return setAsk(mode);
    if (pref(ON_DEVICE_KEY)) return void tryOnDevice();
    if (pref(ONLINE_OK_KEY)) return start(false);
    setAsk(mode);
  };

  const body =
    ask?.kind === 'unsupported'
      ? 'This browser or app has no built-in speech recognition. Use the microphone on your keyboard instead (Gboard on Pixel, Win + H on Windows) — it types straight into Quick Add.'
      : ask?.kind === 'on-device-downloadable'
        ? 'Your browser can recognise speech on this device after downloading a language pack. Audio then never leaves the device. Download it now?'
        : 'On this device, speech is recognised by your browser’s online service: audio is sent over the internet (Focus itself sends nothing). Offline dictation needs a browser with on-device recognition, or your keyboard’s offline voice typing.';

  return (
    <>
      <IconButton
        label={listening ? 'Stop dictation' : 'Dictate a task'}
        onClick={() => void click()}
        className={cx(listening && 'animate-pulse bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-danger')}
      >
        {listening ? <MicOff size={18} /> : <Mic size={18} />}
      </IconButton>
      {ask?.kind === 'unsupported' ? (
        <ConfirmDialog open title="Dictation" body={body} confirmLabel="OK" onConfirm={() => {}} onClose={() => setAsk(null)} />
      ) : (
        <ConfirmDialog
          open={!!ask}
          title="Dictation"
          body={
            <>
              {body}
              {ask?.kind === 'on-device-downloadable' && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => (setAsk(null), start(false))}>
                  Use online recognition this time
                </Button>
              )}
              {ask?.kind === 'online' && supportsOnDeviceProbe() && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => (setAsk(null), void tryOnDevice())}>
                  Try on-device recognition instead (experimental)
                </Button>
              )}
            </>
          }
          confirmLabel={ask?.kind === 'on-device-downloadable' ? 'Download' : 'Continue'}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            if (ask?.kind === 'on-device-downloadable') {
              void installOnDevice(LANG).then((done) => {
                pushToast({ message: done ? 'Language pack installed — tap the microphone again' : 'The language pack could not be installed', tone: done ? 'success' : 'error' });
              });
            } else {
              setPref(ONLINE_OK_KEY);
              start(false);
            }
          }}
        />
      )}
    </>
  );
}
