/** Imported tasks (Claude links, shares, Capture, the local API) go to the Inbox and never create projects. */
import { describe, expect, it } from 'vitest';
import { stripProjectTags } from '@/core/nlp/parser';
import { makeApp } from './helpers';

describe('imports land in the Inbox', () => {
  it('strips project tags but keeps labels, dates and priority', () => {
    const r = stripProjectTags('Phone dentist Friday 10am #Home p2 @calls', { projects: [], labels: [] });
    expect(r).toEqual({ text: 'Phone dentist Friday 10am p2 @calls', suggested: ['Home'] });
    // "#garden" that names an existing label stays (it means the label).
    expect(stripProjectTags('Weed beds #garden', { labels: [{ id: 'l1', name: 'garden' }] }).text).toBe('Weed beds #garden');
  });

  it('a Claude daily brief pasted into Capture creates no projects, even with repeated #Home', async () => {
    const { app } = await makeApp();
    const brief = [
      '- [ ] Phone dentist Friday #Home',
      '- [ ] Fix the gate by 20 Nov #Home',
      '- [ ] Book boiler service #Home p2',
      '- [ ] Renew car insurance by 30 Nov #Home',
      "- [ ] Plan Mum's birthday #Family",
    ].join('\n');
    const { source, candidates } = app.capture.analyse(brief);
    expect(candidates.map((c) => c.text)).toEqual(['Phone dentist Friday', 'Fix the gate by 20 Nov', 'Book boiler service p2', 'Renew car insurance by 30 Nov', "Plan Mum's birthday"]);
    expect(candidates[0]!.suggestedProjects).toEqual(['Home']);
    const made = app.capture.commit(candidates, source, null);
    expect(app.repos.projects.list()).toEqual([]);
    expect(made.every((t) => t.projectId === null && t.status === 'inbox')).toBe(true);
    // Dated tasks are in the Inbox too (and also on Upcoming).
    expect(app.repos.tasks.listInbox().map((t) => t.title)).toContain('Fix the gate');
    expect(made.find((t) => t.title === 'Fix the gate')!.deadline).toBe('2026-11-20');
    expect(made[4]!.description).toContain('Suggested project: Family');
  });

  it('a #Project typed into a Capture row is also only a suggestion', async () => {
    const { app } = await makeApp();
    const { source } = app.capture.analyse('Buy milk');
    const [t] = app.capture.commit([{ text: 'Buy milk #Shopping', sourceLine: 'Buy milk' }], source, null);
    expect(t!.projectId).toBeNull();
    expect(app.repos.projects.list().some((p) => p.name === 'Shopping')).toBe(false);
  });

  it('the local API text path puts tasks in the Inbox; an explicit existing project still works', async () => {
    const { app } = await makeApp();
    const home = app.projects.create({ name: 'Home' });
    const post = (body: unknown) => app.api.handle({ method: 'POST', path: '/v1/tasks', query: '', body: JSON.stringify(body) }, []);
    const a = post({ text: 'Mow lawn Saturday #Garden' }).body as { task: { projectId: string | null; description: string } };
    expect(a.task.projectId).toBeNull();
    expect(a.task.description).toContain('Suggested project: Garden');
    expect(app.repos.projects.list().some((p) => p.name === 'Garden')).toBe(false);
    const b = post({ text: 'Paint fence', projectId: home.id }).body as { task: { projectId: string } };
    expect(b.task.projectId).toBe(home.id);
  });
});
