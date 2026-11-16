/**
 * End-to-end encryption for sync (ADR-019).
 *
 * One random 256-bit sync key, shown to the user once (and as a join link/QR). From it, HKDF
 * derives three independent values:
 *   - vault id   (public; names the mailbox on the relay)
 *   - auth token (sent to the relay, which stores only its hash)
 *   - data key   (AES-256-GCM; never leaves the devices)
 * Knowing the vault id or token gives the relay nothing it can decrypt with.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SYNC_KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;

export class SyncKeyError extends Error {}
export class SyncDecryptError extends Error {}

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new SyncKeyError(`“${ch}” isn’t part of a sync key`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new random sync key, formatted in groups of four for reading aloud or typing. */
export function generateSyncKey(): string {
  const b = new Uint8Array(SYNC_KEY_BYTES);
  crypto.getRandomValues(b);
  return formatSyncKey(b);
}

export function formatSyncKey(bytes: Uint8Array): string {
  return toBase32(bytes).match(/.{1,4}/g)!.join('-');
}

export function parseSyncKey(s: string): Uint8Array {
  const bytes = fromBase32(s);
  if (bytes.length !== SYNC_KEY_BYTES) throw new SyncKeyError('That sync key is incomplete or too long. Check it was copied in full.');
  return bytes;
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export interface SyncKeys {
  vaultId: string;
  token: string;
  dataKey: CryptoKey;
}

export async function deriveSyncKeys(syncKey: string): Promise<SyncKeys> {
  const raw = parseSyncKey(syncKey);
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = enc.encode('focus-sync-v1');
  const bits = (info: string, n: number) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, n);
  const vaultId = hex(await bits('vault-id', 128));
  const token = hex(await bits('relay-auth', 256));
  const dataKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('data-key') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { vaultId, token, dataKey };
}

async function gzip(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new SyncDecryptError('This device can’t read compressed sync data');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a JSON value: [version][flags][12-byte IV][AES-GCM ciphertext], base64. The vault id is bound as AAD. */
export async function sealJson(keys: SyncKeys, value: unknown): Promise<string> {
  const plain = enc.encode(JSON.stringify(value));
  const zipped = await gzip(plain);
  const body = zipped && zipped.length < plain.length ? zipped : plain;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.vaultId) }, keys.dataKey, body as BufferSource));
  const out = new Uint8Array(2 + 12 + ct.length);
  out[0] = ENVELOPE_VERSION;
  out[1] = body === plain ? 0 : 1;
  out.set(iv, 2);
  out.set(ct, 14);
  return toBase64(out);
}

export async function openJson<T = unknown>(keys: SyncKeys, data: string): Promise<T> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(data);
  } catch {
    throw new SyncDecryptError('Damaged sync data');
  }
  if (bytes[0] !== ENVELOPE_VERSION) throw new SyncDecryptError('Sync data from a newer version of Focus; please update this device');
  let body: Uint8Array;
  try {
    body = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(2, 14) as BufferSource, additionalData: enc.encode(keys.vaultId) }, keys.dataKey, bytes.subarray(14) as BufferSource),
    );
  } catch {
    throw new SyncDecryptError('Sync data couldn’t be decrypted with this key');
  }
  if (bytes[1] === 1) body = await gunzip(body);
  return JSON.parse(dec.decode(body)) as T;
}
