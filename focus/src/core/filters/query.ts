/**
 * Advanced filter query language ⇄ filter tree.
 *
 *   p1 & due:this-week
 *   #Home & deadline:this-month
 *   (overdue | p1) & !@waiting-on
 *   duration<15 & scheduled:none
 *   status:waiting
 *
 * Operators: `&`/`and`, `|`/`or`, `!`/`not`, parentheses. Terms next to each
 * other without an operator are ANDed. Precedence: not > and > or.
 */
import { DATE_FIELDS, type CmpOp, type Condition, type DateField, type FilterDefinition, type Rule } from './types';
import { STATUS_VALUES } from './types';

export interface NamedEntity {
  id: string;
  name: string;
}

export interface QueryLookups {
  projects: readonly NamedEntity[];
  labels: readonly NamedEntity[];
}

export interface ParseOutcome {
  definition: FilterDefinition | null;
  error: string | null;
}

type Tok = { t: '(' | ')' | '&' | '|' | '!' } | { t: 'term'; v: string };

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === '&' || c === '|' || c === '!') {
      out.push({ t: c });
      i++;
      continue;
    }
    // A term runs until whitespace or an operator, but quoted sections may contain anything.
    let term = '';
    while (i < input.length && !/[\s()&|]/.test(input[i]!)) {
      if (input[i] === '"') {
        const end = input.indexOf('"', i + 1);
        if (end < 0) throw new Error('Missing closing quote');
        term += input.slice(i, end + 1);
        i = end + 1;
      } else term += input[i++];
    }
    const low = term.toLowerCase();
    if (low === 'and') out.push({ t: '&' });
    else if (low === 'or') out.push({ t: '|' });
    else if (low === 'not') out.push({ t: '!' });
    else out.push({ t: 'term', v: term });
  }
  return out;
}

const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1');
const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').trim();

function parseMinutes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m|min|h)?$/i.exec(s);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 60 : 1));
}

const CMP_MAP: Record<string, CmpOp> = { ':': '=', '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const DATE_CMP: Record<string, 'before' | 'after' | 'onOrBefore' | 'onOrAfter'> = { '<': 'before', '>': 'after', '<=': 'onOrBefore', '>=': 'onOrAfter' };

function termToRule(raw: string, lk: QueryLookups): Condition {
  const low = raw.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^p([1-4])$/.exec(low))) return { kind: 'rule', field: 'priority', op: '=', value: Number(m[1]) };
  if ((m = /^priority(<=|>=|!=|=|<|>|:)([1-4])$/.exec(low))) return { kind: 'rule', field: 'priority', op: CMP_MAP[m[1]!]!, value: Number(m[2]) };
  if (raw.startsWith('#')) {
    const name = unquote(raw.slice(1));
    if (norm(name) === 'inbox') return { kind: 'rule', field: 'project', op: 'in', value: ['inbox'] };
    const p = lk.projects.find((x) => norm(x.name) === norm(name));
    if (!p) throw new Error(`No project called “${name}”`);
    return { kind: 'rule', field: 'project', op: 'in', value: [p.id] };
  }
  if (raw.startsWith('@')) {
    const name = unquote(raw.slice(1));
    if (norm(name) === 'none') return { kind: 'rule', field: 'label', op: 'hasNone', value: [] };
    const l = lk.labels.find((x) => norm(x.name) === norm(name));
    if (!l) throw new Error(`No label called “${name}”`);
    return { kind: 'rule', field: 'label', op: 'hasAny', value: [l.id] };
  }
  if ((m = /^status:([a-z_,]+)$/.exec(low))) {
    const values = m[1]!.split(',').filter(Boolean);
    const bad = values.find((v) => !STATUS_VALUES.includes(v));
    if (bad) throw new Error(`Unknown status “${bad}”. Use: ${STATUS_VALUES.join(', ')}`);
    return { kind: 'rule', field: 'status', op: 'is', value: values };
  }
  if ((m = /^(duration|estimate)(<=|>=|!=|=|<|>|:)(.+)$/.exec(low))) {
    if (m[3] === 'none' || m[3] === 'any') return { kind: 'rule', field: 'duration', op: m[3] };
    const n = parseMinutes(m[3]!);
    if (n === null) throw new Error(`“${m[3]}” is not a duration (use minutes, e.g. 15 or 1h)`);
    return { kind: 'rule', field: 'duration', op: CMP_MAP[m[2]!]!, value: n };
  }
  if ((m = new RegExp(`^(${DATE_FIELDS.join('|')})(<=|>=|<|>|:|=)(.+)$`).exec(low))) {
    const field = m[1] as DateField;
    const op = m[2]!;
    const v = m[3]!;
    if (op === ':' || op === '=') {
      if (v === 'none' || v === 'any' || v === 'overdue') return { kind: 'rule', field, op: v };
      const range = /^(.+)\.\.(.+)$/.exec(v);
      if (range) return { kind: 'rule', field, op: 'between', value: range[1]!, value2: range[2]! };
      return { kind: 'rule', field, op: 'on', value: v };
    }
    return { kind: 'rule', field, op: DATE_CMP[op]!, value: v };
  }
  if (low === 'overdue') return { kind: 'rule', field: 'due', op: 'overdue' };
  if (low === 'blocked' || low === 'blocking') return { kind: 'rule', field: 'dependency', op: low };
  if (low === 'recurring') return { kind: 'rule', field: 'recurring', op: 'yes' };
  if (low === 'subtask') return { kind: 'rule', field: 'subtask', op: 'yes' };
  if ((m = /^search:(.+)$/i.exec(raw))) return { kind: 'rule', field: 'text', op: 'contains', value: unquote(m[1]!) };
  // Anything else is a text search, which is the friendliest fallback.
  return { kind: 'rule', field: 'text', op: 'contains', value: unquote(raw) };
}

export function parseQuery(input: string, lk: QueryLookups): ParseOutcome {
  try {
    const toks = tokenize(input);
    if (toks.length === 0) return { definition: null, error: 'Type a filter, e.g. p1 & due:this-week' };
    let i = 0;
    const peek = () => toks[i];
    const parseOr = (): Condition => {
      const parts = [parseAnd()];
      while (peek()?.t === '|') {
        i++;
        parts.push(parseAnd());
      }
      return parts.length === 1 ? parts[0]! : { kind: 'group', op: 'or', children: parts };
    };
    const parseAnd = (): Condition => {
      const parts = [parseUnary()];
      while (peek() && (peek()!.t === '&' || peek()!.t === 'term' || peek()!.t === '!' || peek()!.t === '(')) {
        if (peek()!.t === '&') i++;
        parts.push(parseUnary());
      }
      return parts.length === 1 ? parts[0]! : { kind: 'group', op: 'and', children: parts };
    };
    const parseUnary = (): Condition => {
      const tok = toks[i++];
      if (!tok) throw new Error('The filter ends too early');
      if (tok.t === '!') return { kind: 'not', child: parseUnary() };
      if (tok.t === '(') {
        const inner = parseOr();
        if (toks[i++]?.t !== ')') throw new Error('Missing closing bracket');
        return inner;
      }
      if (tok.t === 'term') return termToRule(tok.v, lk);
      throw new Error(`Unexpected “${tok.t}”`);
    };
    const root = parseOr();
    if (i < toks.length) throw new Error(`Unexpected “${(toks[i] as { v?: string; t: string }).v ?? toks[i]!.t}”`);
    return { definition: { v: 1, root }, error: null };
  } catch (err) {
    return { definition: null, error: (err as Error).message };
  }
}

const quoteIfNeeded = (s: string) => (/^[\w-]+$/u.test(s) ? s : `"${s}"`);

function ruleToText(r: Rule, lk: QueryLookups): string {
  const nameOf = (list: readonly NamedEntity[], id: string) => list.find((x) => x.id === id)?.name ?? id;
  switch (r.field) {
    case 'priority':
      return r.op === '=' ? `p${r.value}` : `priority${r.op}${r.value}`;
    case 'status':
      return `${r.op === 'isNot' ? '!' : ''}status:${r.value.join(',')}`;
    case 'project': {
      const parts = r.value.map((id) => `#${id === 'inbox' ? 'inbox' : quoteIfNeeded(nameOf(lk.projects, id))}`);
      const body = parts.length > 1 ? `(${parts.join(' | ')})` : (parts[0] ?? '#inbox');
      return r.op === 'notIn' ? `!${body}` : body;
    }
    case 'label': {
      if (r.op === 'hasNone' && r.value.length === 0) return '@none';
      const parts = r.value.map((id) => `@${quoteIfNeeded(nameOf(lk.labels, id))}`);
      if (r.op === 'hasAll') return parts.length > 1 ? `(${parts.join(' & ')})` : parts[0]!;
      const any = parts.length > 1 ? `(${parts.join(' | ')})` : parts[0]!;
      return r.op === 'hasNone' ? `!${any}` : any;
    }
    case 'duration':
      return r.op === 'none' || r.op === 'any' ? `duration:${r.op}` : `duration${r.op === '=' ? ':' : r.op}${r.value}`;
    case 'text':
      return /^[\w-]+$/u.test(r.value) && !/^p[1-4]$/i.test(r.value) ? r.value : `search:"${r.value.replace(/"/g, '')}"`;
    case 'dependency':
      return r.op === 'free' ? '(!blocked & !blocking)' : r.op;
    case 'recurring':
    case 'subtask':
      return r.op === 'yes' ? r.field : `!${r.field}`;
    default: {
      const sym: Record<string, string> = { before: '<', after: '>', onOrBefore: '<=', onOrAfter: '>=' };
      if (r.op === 'none' || r.op === 'any' || r.op === 'overdue') return r.field === 'due' && r.op === 'overdue' ? 'overdue' : `${r.field}:${r.op}`;
      if (r.op === 'between') return `${r.field}:${r.value}..${r.value2}`;
      if (r.op === 'on') return `${r.field}:${r.value}`;
      return `${r.field}${sym[r.op]}${r.value}`;
    }
  }
}

/** Serialise a filter tree back to query text (used to keep the visual and text editors in sync). */
export function toQuery(c: Condition, lk: QueryLookups, parentOp?: 'and' | 'or'): string {
  if (c.kind === 'not') {
    const inner = toQuery(c.child, lk, 'and');
    return `!${c.child.kind === 'group' ? `(${inner})` : inner}`;
  }
  if (c.kind === 'group') {
    if (c.children.length === 0) return '';
    const sep = c.op === 'and' ? ' & ' : ' | ';
    const body = c.children.map((x) => toQuery(x, lk, c.op)).filter(Boolean).join(sep);
    const needsParens = (parentOp && parentOp !== c.op && c.children.length > 1) || c.not;
    const wrapped = needsParens ? `(${body})` : body;
    return c.not ? `!${wrapped}` : wrapped;
  }
  return ruleToText(c, lk);
}
