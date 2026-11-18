#!/usr/bin/env node
// Focus connector for Claude (Model Context Protocol over stdio). No dependencies: Node 18+.
//
// It lets Claude Desktop / Claude Code on the SAME computer add, find, edit and complete
// Focus tasks through Focus's local API. Focus must be running with Settings → Local API on.
//
//   FOCUS_API_TOKEN  the token from Settings → Local API (required)
//   FOCUS_API_URL    default http://127.0.0.1:47615
//
// Nothing here talks to the internet: requests go only to the Focus app on this computer.

const URL_BASE = (process.env.FOCUS_API_URL || 'http://127.0.0.1:47615').replace(/\/+$/, '');
const TOKEN = process.env.FOCUS_API_TOKEN || '';
const VERSION = '0.5.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const log = (...a) => process.stderr.write(`[focus-mcp] ${a.join(' ')}\n`);

async function api(method, path, body) {
  if (!TOKEN) throw new Error('FOCUS_API_TOKEN is not set. Copy the token from Focus → Settings → Local API.');
  let res;
  try {
    res = await fetch(URL_BASE + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach Focus at ${URL_BASE}. Is Focus open, with Settings → Local API switched on?`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(`Focus answered ${res.status}: ${data.error || text}${data.hint ? ` (${data.hint})` : ''}`);
  return data;
}

const str = (description) => ({ type: 'string', description });
const date = (what) => ({ type: 'string', description: `${what} as YYYY-MM-DD`, pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

const TOOLS = [
  {
    name: 'add_task',
    description:
      'Add a task to Focus. Prefer "text", written the way you would type it into Focus Quick Add: e.g. "Phone dentist Friday 10am #Home p2 @calls", ' +
      '"Pay rent every month on the 1st", "Finish report by 20 November". #Project, @label, p1 (highest) to p4, dates, times, "every …" repeats and "for 30m" durations are understood. ' +
      'Alternatively give "title" plus structured fields.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Natural-language task, as typed into Quick Add'),
        title: str('Task title (when not using text)'),
        description: str('Notes for the task'),
        project: str('Existing project name'),
        projectId: str('Project id'),
        parentId: str('Make it a subtask of this task id'),
        priority: { type: 'integer', minimum: 1, maximum: 4, description: '1 = highest, 4 = none' },
        scheduledDate: date('When to do it'),
        scheduledTime: { type: 'string', description: 'HH:MM, 24-hour', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        deadline: date('When it must be done'),
        durationMinutes: { type: 'integer', minimum: 1 },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names (created if new)' },
      },
    },
    run: (a) => api('POST', '/v1/tasks', a),
  },
  {
    name: 'list_tasks',
    description: 'List Focus tasks. Optional Focus filter query, e.g. "today | overdue", "#Home & @calls", "p1", "due before: 2026-12-01".',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Default open' },
        filter: str('Focus filter query'),
        projectId: str('Only this project'),
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    run: (a) => {
      const q = new URLSearchParams();
      for (const k of ['status', 'filter', 'projectId', 'limit']) if (a[k] !== undefined) q.set(k, String(a[k]));
      return api('GET', `/v1/tasks${q.size ? `?${q}` : ''}`);
    },
  },
  {
    name: 'update_task',
    description: 'Change fields of a task (only the ones given). Use complete_task to complete it. Tasks cannot be deleted through this connector.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: str('Task id'),
        title: str('New title'),
        description: str('New notes'),
        projectId: { type: ['string', 'null'], description: 'Project id, or null for Inbox' },
        priority: { type: 'integer', minimum: 1, maximum: 4 },
        status: { type: 'string', enum: ['inbox', 'active', 'in_progress', 'waiting'] },
        scheduledDate: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
        scheduledTime: { type: ['string', 'null'], description: 'HH:MM or null' },
        deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
        durationMinutes: { type: ['integer', 'null'] },
        labels: { type: 'array', items: { type: 'string' } },
        force: { type: 'boolean', description: 'Go ahead despite a dependency warning (only after asking the user)' },
      },
    },
    run: ({ id, force, ...fields }) => api('PATCH', `/v1/tasks/${encodeURIComponent(id)}${force ? '?force=true' : ''}`, fields),
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done (repeating tasks get their next occurrence). If Focus warns that it is waiting on another task, ask the user before retrying with force.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('Task id'), force: { type: 'boolean' } } },
    run: ({ id, force }) => api('POST', `/v1/tasks/${encodeURIComponent(id)}/complete${force ? '?force=true' : ''}`),
  },
  {
    name: 'reopen_task',
    description: 'Mark a completed task as not done.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('Task id') } },
    run: ({ id }) => api('POST', `/v1/tasks/${encodeURIComponent(id)}/reopen`),
  },
  { name: 'list_projects', description: 'List Focus projects with their open task counts.', inputSchema: { type: 'object', properties: {} }, run: () => api('GET', '/v1/projects') },
  {
    name: 'create_project',
    description: 'Create a Focus project.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: str('Project name'), parentId: str('Parent project id (optional)') } },
    run: (a) => api('POST', '/v1/projects', a),
  },
  { name: 'list_labels', description: 'List Focus labels.', inputSchema: { type: 'object', properties: {} }, run: () => api('GET', '/v1/labels') },
  {
    name: 'list_automations',
    description: 'List the Focus automations the user has approved for running on request.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/automations'),
  },
  {
    name: 'run_automation',
    description: 'Run an approved Focus automation for a task (or a project, for project automations).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('Automation id'), taskId: str('Task id'), projectId: str('Project id') } },
    run: ({ id, ...target }) => api('POST', `/v1/automations/${encodeURIComponent(id)}/run`, target),
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function onMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id !== undefined) fail(msg.id, -32600, 'Invalid request');
    return;
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return; // notifications (e.g. notifications/initialized) need no answer
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'focus', version: VERSION },
        instructions:
          'Focus is the user’s local to-do app. Use add_task with natural-language "text" for new tasks. Confirm with the user before changing or completing existing tasks.',
      });
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${p.name}`);
      try {
        const data = await tool.run(p.arguments || {});
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        return reply(msg.id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

let buffer = '';
const inFlight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    const p = onMessage(msg).catch((e) => log('error', e && e.stack ? e.stack : String(e)));
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }
});
// Finish calls already in progress before exiting when the client closes the pipe.
process.stdin.on('end', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
log(`ready; Focus API at ${URL_BASE}${TOKEN ? '' : ' (FOCUS_API_TOKEN not set!)'}`);
