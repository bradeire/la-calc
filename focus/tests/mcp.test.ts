import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../tools/focus-mcp/focus-mcp.mjs');
const TOKEN = 'a'.repeat(64);
const seen: { method: string; url: string; auth: string; body: string }[] = [];
let url = '';
const server = createServer((req: IncomingMessage, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"error":"Missing or wrong API token"}');
    if (req.url === '/v1/tasks' && req.method === 'POST') return res.writeHead(201).end(JSON.stringify({ task: { id: 't1', title: 'Phone dentist' } }));
    if (req.url?.startsWith('/v1/tasks/t9/complete')) return res.writeHead(409).end('{"error":"This task is waiting on another","hint":"Repeat with ?force=true to go ahead"}');
    res.writeHead(200).end(JSON.stringify({ tasks: [], total: 0 }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** Send JSON-RPC lines to the connector and collect one reply per request. */
async function session(messages: object[], env: Record<string, string>) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Record<string, unknown>[] = [];
  let buf = '';
  const expected = messages.filter((m) => 'id' in m).length;
  const done = new Promise<void>((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(out)}`)), 8000);
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (out.length === expected) {
          clearTimeout(timer);
          resolveDone();
        }
      }
    });
  });
  for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  await done;
  child.kill();
  return out;
}

describe('Claude connector (MCP)', () => {
  it('initialises, lists tools and forwards calls with the token', async () => {
    const out = await session(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_task', arguments: { text: 'Phone dentist Friday 10am #Home' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_tasks', arguments: { filter: 'today | overdue' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'complete_task', arguments: { id: 't9' } } },
        { jsonrpc: '2.0', id: 6, method: 'nope' },
      ],
      { FOCUS_API_URL: url, FOCUS_API_TOKEN: TOKEN },
    );
    const byId = Object.fromEntries(out.map((m) => [m.id as number, m]));
    expect(byId[1]).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'focus' } } });
    const tools = (byId[2]!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['add_task', 'list_tasks', 'update_task', 'complete_task', 'list_projects', 'create_project', 'list_labels', 'run_automation']));
    expect(tools).not.toContain('delete_task');
    expect(JSON.stringify(byId[3]!.result)).toContain('Phone dentist');
    expect(seen.find((s) => s.method === 'POST' && s.url === '/v1/tasks')).toMatchObject({ auth: `Bearer ${TOKEN}`, body: JSON.stringify({ text: 'Phone dentist Friday 10am #Home' }) });
    expect(seen.some((s) => s.url === '/v1/tasks?filter=today+%7C+overdue')).toBe(true);
    expect(byId[5]).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(byId[5])).toContain('force=true');
    expect(byId[6]).toMatchObject({ error: { code: -32601 } });
  });

  it('explains a missing token or an unreachable Focus instead of failing silently', async () => {
    const [noToken] = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_labels', arguments: {} } }], { FOCUS_API_URL: url, FOCUS_API_TOKEN: '' });
    expect(JSON.stringify(noToken)).toContain('FOCUS_API_TOKEN is not set');
    const [down] = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_labels', arguments: {} } }], { FOCUS_API_URL: 'http://127.0.0.1:1', FOCUS_API_TOKEN: TOKEN });
    expect(JSON.stringify(down)).toContain('Is Focus open');
  });
});
