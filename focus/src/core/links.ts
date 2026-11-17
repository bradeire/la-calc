/**
 * Tap-to-add links (focus://add?text=…, focus://capture?text=…).
 *
 * A link only ever *pre-fills* Quick Add or the Capture dialog; nothing is created
 * until the user confirms. Anyone can send a link, so the text is length-capped and
 * stripped of control characters, and unknown actions are ignored.
 */
export type IncomingLink = { kind: 'add'; text: string } | { kind: 'capture'; text: string } | { kind: 'sync'; relay: string; key: string };

export const LINK_SCHEMES = ['focus', 'web+focus'] as const;
export const MAX_ADD_LENGTH = 500;
export const MAX_CAPTURE_LENGTH = 20_000;

const clean = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();

export function parseIncomingLink(raw: string): IncomingLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!(LINK_SCHEMES as readonly string[]).includes(scheme)) return null;
  // focus://add?… puts "add" in the host; focus:add?… and focus:///add?… put it in the path.
  const action = (url.host || url.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
  if (action === 'sync') {
    // Join link from another device: never acted on without the user confirming.
    const relay = (url.searchParams.get('relay') ?? '').trim();
    const key = (url.searchParams.get('key') ?? '').trim().toUpperCase();
    if (!/^https:\/\/[^\s]+$/i.test(relay) || !/^[0-9A-Z-]{40,80}$/.test(key)) return null;
    return { kind: 'sync', relay, key };
  }
  const text = clean(url.searchParams.get('text') ?? url.searchParams.get('t') ?? '');
  if (!text) return null;
  if (action === 'add') {
    // Several lines are several tasks: review them in Capture rather than one long title.
    if (text.includes('\n')) return { kind: 'capture', text: text.slice(0, MAX_CAPTURE_LENGTH) };
    return { kind: 'add', text: text.slice(0, MAX_ADD_LENGTH) };
  }
  if (action === 'capture') return { kind: 'capture', text: text.slice(0, MAX_CAPTURE_LENGTH) };
  return null;
}

/** Percent-encode everything except unreserved characters, so links survive chat apps and Markdown. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export const buildAddLink = (text: string) => `focus://add?text=${encode(text.trim())}`;
export const buildSyncLink = (relay: string, key: string) => `focus://sync?relay=${encodeURIComponent(relay)}&key=${encodeURIComponent(key)}`;
export const buildCaptureLink = (text: string) => `focus://capture?text=${encode(text.trim())}`;

/**
 * Chat apps only make http(s) links tappable, so links for Claude go through the relay's /open page,
 * which hands them to focus://. The text is after the #, so it never reaches the server.
 */
export const openPageBase = (relayUrl: string) => `${relayUrl.trim().replace(/\/+$/, '')}/open#`;
export const buildOpenLink = (relayUrl: string, text: string) => `${openPageBase(relayUrl)}add?text=${encode(text.trim())}`;

/** Instructions a user can paste into Claude (or another assistant) so it replies with tap-to-add links. */
export function assistantInstructions(relayUrl: string | null): string {
  const base = relayUrl ? openPageBase(relayUrl) : 'focus://';
  return `When I ask you to add tasks to Focus (my to-do app), reply with one Markdown link per task in this form:
[Task title and details](${base}add?text=URL-ENCODED-TEXT)
Write the text the way I'd type it in Focus Quick Add, e.g. "Phone dentist Friday 10am p2 @calls":
- dates/times in plain English: today, tomorrow, Fri 3pm, 20 Nov, every Monday, every 4 weeks after completion
- deadline: "by 20 November"; duration: "for 30m"; start: "starts Monday"
- @label, priority p1 (highest) to p4
- no #project tags: Focus puts these tasks in my Inbox and I file them myself (if you think a project fits, say so in the plain list instead)
Percent-encode the text (space = %20, # = %23, @ = %40, & = %26).
For a whole list at once, also give one link: [Add all](${base}capture?text=ONE-TASK-PER-LINE-URL-ENCODED) with lines separated by %0A.
Then show the same tasks as a plain list too, so I can copy it into Focus if a link doesn't open.`;
}
