/**
 * RFC 4180 CSV. Writing quotes fields containing separators, quotes or line breaks and
 * neutralises spreadsheet formulas (CSV injection); reading handles quoted fields with
 * embedded commas, quotes and newlines, CRLF/LF, a UTF-8 BOM and ; or tab separators.
 */

/** Cells starting with these are treated as formulas by Excel/Sheets/LibreOffice. */
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // A leading apostrophe makes spreadsheets show the text instead of running it.
  if (FORMULA.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text with a BOM so Excel opens UTF-8 correctly, and CRLF line ends. */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function detectSeparator(firstLine: string): ',' | ';' | '\t' {
  const count = (c: string) => firstLine.split(c).length - 1;
  const c = count(',');
  const s = count(';');
  const t = count('\t');
  return t > c && t > s ? '\t' : s > c ? ';' : ',';
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const sep = detectSeparator(src.slice(0, src.search(/\r?\n/) >>> 0 || src.length));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Drop blank lines.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Rows as objects keyed by lower-cased, trimmed header names. */
export function csvRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const [head, ...body] = parseCsv(text);
  if (!head) return { headers: [], records: [] };
  const headers = head.map((h) => h.trim().toLowerCase());
  return {
    headers,
    records: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}
