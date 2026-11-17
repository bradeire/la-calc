/**
 * Deterministic action extraction from pasted text, emails and meeting notes
 * (spec 5.6). Results are *suggestions*; nothing is created until the user confirms.
 */
import { parseIncomingLink } from './links';
import { parseQuickAdd, type ParseContext, type ParseResult } from './nlp/parser';

export interface CaptureSource {
  kind: 'email' | 'notes';
  subject: string | null;
  from: string | null;
  body: string;
}

export interface Candidate {
  /** Text handed to the Quick Add parser (dates, #project, @label, p1 still work). */
  text: string;
  parsed: ParseResult;
  sourceLine: string;
  confidence: 'high' | 'medium';
  why: string;
}

const HEADER = /^(subject|from|to|cc|date|sent):\s*(.*)$/i;

/** Split an email (pasted or .eml) into headers and the new part of the body. */
export function parseSource(raw: string): CaptureSource {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let subject: string | null = null;
  let from: string | null = null;
  let i = 0;
  let headerCount = 0;
  while (i < lines.length && i < 40) {
    const m = HEADER.exec(lines[i]!.trim());
    if (m) {
      headerCount++;
      if (m[1]!.toLowerCase() === 'subject') subject = m[2]!.trim() || null;
      if (m[1]!.toLowerCase() === 'from') from = m[2]!.trim() || null;
      i++;
    } else if (headerCount > 0 && /^\s+\S/.test(lines[i]!)) i++; // folded header line
    else break;
  }
  const isEmail = headerCount >= 2 && !!subject;
  let body = isEmail ? lines.slice(i).join('\n') : text;
  if (isEmail) {
    // Drop quoted history and signatures: only the new message is relevant.
    const cut = body.search(/^(On .+wrote:|-----Original Message-----|From: .+\nSent: |-- ?$)/m);
    if (cut > 0) body = body.slice(0, cut);
    body = body.split('\n').filter((l) => !l.trimStart().startsWith('>')).join('\n');
  }
  return { kind: isEmail ? 'email' : 'notes', subject, from, body: body.trim() };
}

const ACTION_HEADINGS = /^(#+\s*)?(action items?|actions|next steps|to ?dos?|follow[- ]ups?|tasks)\s*:?\s*$/i;
const PREFIX = /^(?:todo|to do|action(?: item)?|ai|ap|next step|follow[- ]up)\s*[:\-–]\s*(.+)$/i;
const CHECKBOX = /^[-*+]?\s*\[\s?\]\s+(.+)$/;
const BULLET = /^(?:[-*+•]|\d+[.)])\s+(.+)$/;
const REQUEST = /^(?:.*?\b)?(?:could you(?: please)?|can you(?: please)?|would you(?: mind)?|please|kindly|i need you to|we need to|need to|don['’]t forget to|remember to)\s+(.+?)[.?!]*$/i;
const COMMITMENT = /^(?:i['’]ll|i will|i['’]m going to|i need to|i must|i should)\s+(.+?)[.!]*$/i;
const OWNER = /^([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s+(?:to|will)\s+(.+?)[.!]*$/;
const VERBS = new Set(
  'add agree arrange ask book buy call cancel change chase check clean confirm contact create decide draft email file finish fix follow get organise organize pay phone plan post prepare print read reply renew replace request reserve review ring schedule send set share sign sort submit test tidy update upload write'.split(' '),
);

function tidy(s: string): string {
  const t = s
    .replace(/^(?:also|just|then|and|so|maybe|perhaps)\s+/i, '')
    .replace(/\s+(?:as well|too|please)$/i, '')
    .replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;]+$/g, '').replace(/[.!]+$/, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sentence-level split for prose paragraphs. */
function sentences(line: string): string[] {
  return line.split(/(?<=[.?!])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
}

/** focus:// links (bare or in Markdown) and their https://…/open#… bridge form, as found in an assistant's reply. */
const LINK = /(?:web\+)?focus:[^\s)\]>"']+|https?:\/\/[^\s)\]>"'#]+\/open#[^\s)\]>"']+/gi;

/** The texts carried by Focus links on a line (one per task). */
export function linkTexts(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(LINK)) {
    const raw = m[0];
    const hash = raw.indexOf('/open#');
    const link = parseIncomingLink(hash >= 0 && /^https?:/i.test(raw) ? `focus://${raw.slice(hash + 6)}` : raw);
    if (link && link.kind !== 'sync') out.push(...link.text.split('\n'));
  }
  return out.map((t) => t.trim()).filter(Boolean);
}

const LIST_MARK = /^(?:[-*+•]\s*(?:\[\s?\]\s*)?|\[\s?\]\s*|\d+[.)]\s+)/;

export interface ExtractOptions {
  /** The text is a list of tasks, one per line (from a Focus link or a pasted list): take every line. */
  list?: boolean;
}

export function extractCandidates(raw: string, ctx: ParseContext = {}, opts: ExtractOptions = {}): { source: CaptureSource; candidates: Candidate[] } {
  const source = parseSource(raw);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (text: string, sourceLine: string, confidence: Candidate['confidence'], why: string) => {
    const clean = tidy(text);
    if (clean.length < 3 || clean.length > 300) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const parsed = parseQuickAdd(clean, ctx);
    if (!parsed.title.trim()) return;
    out.push({ text: clean, parsed, sourceLine: sourceLine.trim(), confidence, why });
  };

  const lines = source.body.split('\n');
  // Each line as a task: list mode, or (as a fallback) a short list where no line looked like an action.
  const asList = (confidence: Candidate['confidence'], why: string, keep: (line: string) => boolean = () => true) => {
    for (const l of lines) {
      const line = l.trim();
      if (!line || /^[-*+]?\s*\[[xX]\]/.test(line) || ACTION_HEADINGS.test(line) || /^#+\s/.test(line) || !keep(line)) continue;
      const links = linkTexts(line);
      if (links.length) links.forEach((t) => add(t, t, 'high', 'From a Focus link'));
      else add(line.replace(LIST_MARK, ''), line, confidence, why);
      if (out.length >= 100) break;
    }
  };
  if (opts.list) {
    asList('high', 'One task per line');
    return { source, candidates: out };
  }

  let inActionSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const links = linkTexts(line);
    if (links.length) {
      for (const t of links) add(t, t, 'high', 'From a Focus link');
      continue;
    }
    if (!line) {
      inActionSection = false;
      continue;
    }
    if (ACTION_HEADINGS.test(line)) {
      inActionSection = true;
      continue;
    }
    if (/^#+\s/.test(line)) inActionSection = false;
    let m: RegExpExecArray | null;
    if ((m = CHECKBOX.exec(line))) {
      add(m[1]!, line, 'high', 'Unchecked checkbox');
      continue;
    }
    if (/^[-*+]?\s*\[[xX]\]/.test(line)) continue; // already done
    if ((m = PREFIX.exec(line.replace(BULLET, '$1')))) {
      add(m[1]!, line, 'high', 'Marked as an action');
      continue;
    }
    const bullet = BULLET.exec(line)?.[1];
    if (bullet && inActionSection) {
      const owner = OWNER.exec(bullet);
      add(owner ? `${owner[1]}: ${owner[2]}` : bullet, line, 'high', 'Listed under an action heading');
      continue;
    }
    for (const s of bullet ? [bullet] : sentences(line)) {
      if ((m = COMMITMENT.exec(s))) add(m[1]!, line, 'medium', 'Something you said you would do');
      else if ((m = REQUEST.exec(s))) add(m[1]!, line, 'medium', 'A request');
      else if (bullet && VERBS.has(s.split(/\s+/)[0]!.toLowerCase())) add(s, line, 'medium', 'Starts with an action verb');
      else if ((m = OWNER.exec(s)) && VERBS.has(m[2]!.split(/\s+/)[0]!.toLowerCase())) add(`${m[1]}: ${m[2]}`, line, 'medium', `Assigned to ${m[1]}`);
    }
    if (out.length >= 50) break;
  }
  // Nothing looked like an action, but it's a short list (e.g. "Paint fence", "Dentist Friday"): offer each line, unticked.
  // Short lines that aren't sentences (or are bullets) read as to-do items; prose still finds nothing.
  if (!out.length && source.kind === 'notes') asList('high', 'A line from your list', (l) => l.length <= 120 && (LIST_MARK.test(l) || !/[.?!:;,]$/.test(l)));
  return { source, candidates: out };
}
