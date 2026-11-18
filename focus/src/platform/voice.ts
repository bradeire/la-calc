/**
 * Voice capture via the Web Speech API (spec 5.2).
 *
 * Privacy-relevant behaviour, checked at run time rather than assumed:
 *  - Where the browser supports on-device recognition (`processLocally` with the
 *    static `SpeechRecognition.available()` / `install()` methods — experimental,
 *    see MDN), Focus uses it and audio never leaves the device.
 *  - Otherwise the browser's recognition may send audio to an online service
 *    (Chrome does). Focus says so before listening, and the user decides.
 *  - Where there is no speech recognition at all (some webviews), the mic button
 *    explains that and points to the system keyboard's dictation instead.
 */

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface RecognitionCtor {
  new (): Recognition;
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<Availability>;
  install?: (opts: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type VoiceMode =
  | { kind: 'unsupported' }
  | { kind: 'on-device' }
  | { kind: 'on-device-downloadable' }
  | { kind: 'online' };

/**
 * What kind of recognition this device offers for `lang` (e.g. 'en-GB').
 * Probing for on-device support calls the experimental `SpeechRecognition.available()`,
 * which crashed the renderer outright in our Chromium test build (2026-11). It is
 * therefore only done when the user explicitly asks for on-device recognition, and
 * callers must persist data first (see DECISIONS.md ADR-012).
 */
export async function voiceMode(lang: string, opts: { probeOnDevice?: boolean } = {}): Promise<VoiceMode> {
  const C = ctor();
  if (!C) return { kind: 'unsupported' };
  if (opts.probeOnDevice && typeof C.available === 'function') {
    try {
      const a = await C.available({ langs: [lang], processLocally: true });
      if (a === 'available') return { kind: 'on-device' };
      if (a === 'downloadable' || a === 'downloading') return { kind: 'on-device-downloadable' };
    } catch (err) {
      console.warn('On-device speech check failed', err);
    }
  }
  return { kind: 'online' };
}

/** Download the on-device language pack where the browser offers one. */
export function supportsOnDeviceProbe(): boolean {
  return typeof ctor()?.available === 'function';
}

export async function installOnDevice(lang: string): Promise<boolean> {
  const C = ctor();
  if (!C?.install) return false;
  return C.install({ langs: [lang], processLocally: true });
}

export interface ListenHandle {
  stop(): void;
}

export function listen(opts: {
  lang: string;
  onDevice: boolean;
  onText: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): ListenHandle {
  const C = ctor();
  if (!C) throw new Error('Speech recognition is not available here');
  const rec = new C();
  rec.lang = opts.lang;
  rec.interimResults = true;
  rec.continuous = false;
  if (opts.onDevice) rec.processLocally = true;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onText((finalText + interim).trim(), !interim);
  };
  rec.onerror = (e) => {
    const messages: Record<string, string> = {
      'not-allowed': 'Microphone access was blocked. Allow it in your browser or system settings.',
      'no-speech': 'No speech was heard. Try again a little closer to the microphone.',
      network: 'Speech recognition needs an internet connection on this device.',
      'language-not-supported': 'This language is not available for speech recognition here.',
      aborted: '',
    };
    const m = messages[e.error] ?? `Speech recognition stopped (${e.error}).`;
    if (m) opts.onError(m);
  };
  rec.onend = opts.onEnd;
  rec.start();
  return { stop: () => rec.stop() };
}
