import { describe, expect, it } from 'vitest';
import { extractJson, isLocalUrl } from '@/services/ai-service';
import { makeApp } from './helpers';

const ollamaReply = (obj: unknown) => ({ status: 200, body: JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(obj) } }) });
const openaiReply = (obj: unknown) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(obj) + '\n```' } }] }) });

async function aiApp(provider: 'ollama' | 'openai' = 'ollama', baseUrl = 'http://localhost:11434') {
  const ctx = await makeApp();
  await ctx.app.ai.saveConfig({ enabled: true, provider, baseUrl, model: 'test-model' });
  await ctx.app.ai.giveConsent();
  return ctx;
}

describe('AI: consent and configuration', () => {
  it('is off by default and refuses to send anything without consent', async () => {
    const { app, platform } = await makeApp();
    const t = app.tasks.create({ title: 'Plan party' });
    await expect(app.ai.breakdown(t.id)).rejects.toThrow(/turned off/);
    await app.ai.saveConfig({ enabled: true });
    await expect(app.ai.breakdown(t.id)).rejects.toThrow(/not agreed/);
    expect(platform.http.requests).toHaveLength(0);
  });

  it('changing the server address withdraws consent', async () => {
    const { app } = await aiApp();
    expect(app.ai.unavailableReason()).toBeNull();
    await app.ai.saveConfig({ baseUrl: 'https://api.example.com/v1' });
    expect(app.ai.unavailableReason()).toMatch(/not agreed/);
  });

  it('keeps the API key out of the database and sends it only as a bearer token', async () => {
    const { app, platform, db } = await makeApp();
    await app.ai.saveConfig({ enabled: true, provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm' }, 'sk-SECRET');
    await app.ai.giveConsent();
    expect(JSON.stringify(db.all('SELECT * FROM settings'))).not.toContain('sk-SECRET');
    const t = app.tasks.create({ title: 'Write report' });
    platform.http.handler = () => openaiReply({ subtasks: [{ title: 'Outline', minutes: 20 }] });
    expect(await app.ai.breakdown(t.id)).toEqual([{ title: 'Outline', minutes: 20 }]);
    expect(platform.http.requests[0]).toMatchObject({ url: 'https://api.example.com/v1/chat/completions', headers: { Authorization: 'Bearer sk-SECRET' } });
  });

  it('sends descriptions only when allowed', async () => {
    const { app, platform } = await aiApp();
    const t = app.tasks.create({ title: 'Renew passport', description: 'Passport number 123456789' });
    platform.http.handler = () => ollamaReply({ subtasks: [] });
    await app.ai.breakdown(t.id);
    expect(platform.http.requests[0]!.body).not.toContain('123456789');
    await app.ai.saveConfig({ sendDescriptions: true });
    await app.ai.breakdown(t.id);
    expect(platform.http.requests[1]!.body).toContain('123456789');
  });

  it('recognises local addresses', () => {
    expect(isLocalUrl('http://localhost:11434')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:11434')).toBe(true);
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
  });
});

describe('AI: features return validated suggestions only', () => {
  it('suggest maps names to existing projects and labels and changes nothing', async () => {
    const { app, platform } = await aiApp();
    const home = app.projects.create({ name: 'Home' });
    const l = app.labels.create({ name: 'errands' });
    const t = app.tasks.create({ title: 'Buy paint' });
    platform.http.handler = () => ollamaReply({ priority: 2, project: 'home', labels: ['errands', 'unknown'], description: 'Satin finish', minutes: 45 });
    const s = await app.ai.suggest(t.id);
    expect(s).toEqual({ priority: 2, projectId: home.id, projectName: 'Home', labelIds: [l.id], labelNames: ['errands'], description: 'Satin finish', durationMinutes: 45 });
    expect(app.repos.tasks.get(t.id)).toMatchObject({ priority: 4, projectId: null, description: '' });
  });

  it('generated filters are validated by Focus’s own parser', async () => {
    const { app, platform } = await aiApp();
    platform.http.handler = () => ollamaReply({ query: 'p1 & due:this-week' });
    expect(await app.ai.generateFilter('urgent things this week')).toBe('p1 & due:this-week');
    platform.http.handler = () => ollamaReply({ query: '#DoesNotExist' });
    await expect(app.ai.generateFilter('x')).rejects.toThrow(/not a valid filter/);
  });

  it('rejects malformed replies with a clear error', async () => {
    const { app, platform } = await aiApp();
    const t = app.tasks.create({ title: 'x' });
    platform.http.handler = () => ({ status: 200, body: JSON.stringify({ message: { content: 'Sure! Here are some ideas.' } }) });
    await expect(app.ai.breakdown(t.id)).rejects.toThrow(/expected format/);
    platform.http.handler = () => ollamaReply({ subtasks: 'not a list' });
    await expect(app.ai.breakdown(t.id)).rejects.toThrow(/expected shape/);
    platform.http.handler = () => ({ status: 404, body: '' });
    await expect(app.ai.breakdown(t.id)).rejects.toThrow(/not found/);
  });

  it('AI-generated templates are validated before use', async () => {
    const { app, platform } = await aiApp();
    platform.http.handler = () => ollamaReply({ v: 1, project: { description: 'Move' }, sections: ['Before'], tasks: [{ ref: 'a', title: 'Book van', section: 'Before', scheduledOffset: 0 }] });
    const body = await app.ai.generateTemplate('moving house');
    const p = app.templates.instantiateBody(body, { name: 'Move', startDate: '2027-01-10' });
    expect(app.repos.tasks.listByProject(p.id)[0]).toMatchObject({ title: 'Book van', scheduledDate: '2027-01-10' });
  });

  it('extractJson tolerates fences and prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":2} trailing')).toEqual({ a: 2 });
  });
});

describe('capture service', () => {
  it('creates only the chosen suggestions, recording the source', async () => {
    const { app } = await makeApp(new Date(2026, 10, 16, 9));
    const email = 'From: Ann <ann@example.com>\nSubject: Party\n\nCould you book the hall by Friday? Please order the cake.';
    const { source, candidates } = app.capture.analyse(email);
    expect(candidates.map((c) => c.parsed.title)).toEqual(['Book the hall', 'Order the cake']);
    const [hall] = app.capture.commit([candidates[0]!], source, null);
    expect(hall).toMatchObject({ title: 'Book the hall', deadline: '2026-11-20' });
    expect(hall!.description).toContain('From email “Party” — Ann <ann@example.com>');
    expect(app.repos.tasks.listInbox()).toHaveLength(1);
  });

  it('AI mode passes results through the deterministic parser', async () => {
    const { app, platform } = await aiApp();
    platform.http.handler = () => ollamaReply({ tasks: [{ title: 'Call the venue', due: 'tomorrow' }] });
    const { candidates } = await app.capture.analyseWithAi('some notes');
    expect(candidates[0]!.parsed).toMatchObject({ title: 'Call the venue', deadline: expect.any(String) });
  });
});
