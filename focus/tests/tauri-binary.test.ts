/**
 * On Android, Tauri can't pass a raw binary body to Rust (the WebView can't read request bodies),
 * so binary data must be sent as JSON. Saving the database sent a Uint8Array, which Rust rejected,
 * so nothing was ever saved on Android (0.5.0–0.7.3). This checks what the app now sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { cmd: string; args: unknown; options?: unknown }[] = [];
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd: string, args: unknown, options?: unknown) => void calls.push({ cmd, args, options }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-notification', () => ({}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({}));

async function platformWithAgent(ua: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent: ua });
  calls.length = 0;
  const { createTauriPlatform } = await import('@/platform/tauri');
  return createTauriPlatform();
}

afterEach(() => vi.unstubAllGlobals());

describe('binary bodies to Rust', () => {
  const db = new Uint8Array([83, 81, 76, 105, 116, 101, 0, 255]);

  it('Android sends base64 JSON for saves, snapshots and files', async () => {
    const p = await platformWithAgent('Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile');
    await p.persistence.save(db);
    await p.persistence.saveSnapshot('pre-x', db);
    await p.files.put('a1', new Blob([db]));
    expect(calls.map((c) => c.args)).toEqual([{ b64: 'U1FMaXRlAP8=' }, { b64: 'U1FMaXRlAP8=' }, { b64: 'U1FMaXRlAP8=' }]);
    expect(calls[1]!.options).toEqual({ headers: { 'x-focus-name': 'pre-x' } });
  });

  it('desktop keeps sending raw bytes', async () => {
    const p = await platformWithAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140');
    await p.persistence.save(db);
    expect(calls[0]!.args).toBeInstanceOf(Uint8Array);
  });
});
