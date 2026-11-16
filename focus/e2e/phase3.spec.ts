import { expect, test, type Page, type Route } from '@playwright/test';
import { quickAdd, startFresh } from './helpers';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

async function fakeOllama(page: Page, reply: (body: string) => unknown) {
  const seen: string[] = [];
  await page.route('http://localhost:11434/**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postData() ?? '';
    seen.push(body);
    await route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(reply(body)) } }) });
  });
  return seen;
}

async function enableAi(page: Page) {
  await page.goto('/#/settings');
  await page.getByRole('switch', { name: 'Use an AI assistant' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /I agree to send task data/ }).click();
  await expect(page.getByText(/Consent given/)).toBeVisible();
}

test('automation from an example notifies about overdue tasks once', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 9, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Pay invoice 2026-11-10');
  await input.press('Enter');
  await page.goto('/#/automations');
  await page.getByRole('button', { name: /Tell me when a task becomes overdue/ }).click();
  await expect(page.getByRole('heading', { name: 'Edit automation', level: 1 })).toBeVisible();
  await page.clock.fastForward('01:05');
  await expect(page.getByText('Overdue alert: “Pay invoice” is overdue')).toBeVisible();
  // A later sweep must not notify again: the run history shows exactly one run.
  await page.clock.fastForward('01:05');
  await page.goto('/#/automations');
  await page.getByRole('button', { name: /History/ }).click();
  await expect(page.getByText(/Notify: “Pay invoice” is overdue/)).toHaveCount(1);
});

test('build an automation with conditions, test it, and see it run', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/labels');
  await page.getByRole('main').getByRole('button', { name: /New/ }).click();
  await page.getByRole('dialog', { name: 'New label' }).getByRole('textbox', { name: 'Name' }).fill('urgent');
  await page.getByRole('dialog', { name: 'New label' }).getByRole('button', { name: 'Save' }).click();
  await page.goto('/#/automation/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('Tag P1 tasks');
  await page.getByRole('button', { name: 'Add conditions' }).click(); // defaults to "Priority is P1"
  await page.getByRole('combobox', { name: 'Action' }).selectOption('addLabel');
  await page.getByRole('combobox', { name: 'Label' }).selectOption({ label: '@urgent' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  await page.goto('/#/inbox');
  for (const t of ['Fix the leak p1', 'Water plants']) {
    const input = await quickAdd(page, t);
    await input.press('Enter');
  }
  await expect(page.getByRole('listitem', { name: 'Fix the leak' })).toContainText('urgent');
  await expect(page.getByRole('listitem', { name: 'Water plants' })).not.toContainText('urgent');
  await page.goto('/#/automations');
  await page.getByRole('button', { name: /History/ }).click();
  await expect(page.getByText('Added label @urgent')).toBeVisible();
  // Test mode against a non-matching task changes nothing.
  await page.getByRole('button', { name: 'Edit Tag P1 tasks' }).click();
  await page.getByRole('combobox', { name: 'Test task' }).selectOption({ label: 'Water plants' });
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Would not run' })).toBeVisible();
});

test('capture tasks from a pasted email', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 9, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: 'Capture from text' }).click();
  await page.getByRole('textbox', { name: 'Text to capture from' }).fill('From: Sam <sam@example.com>\nSubject: Boiler\n\nCould you book the engineer by Friday? Please send me the warranty.\n\nThanks');
  await page.getByRole('button', { name: 'Find tasks' }).click();
  const list = page.getByRole('list', { name: 'Suggested tasks' });
  await expect(list.getByRole('textbox')).toHaveCount(2);
  // Medium-confidence requests start unticked; tick both.
  await page.getByRole('checkbox', { name: /Book the engineer/ }).check();
  await page.getByRole('checkbox', { name: /Send me the warranty/ }).check();
  await page.getByRole('button', { name: 'Create 2 tasks' }).click();
  await expect(page.getByRole('listitem', { name: 'Book the engineer' })).toBeVisible();
  await page.getByRole('listitem', { name: 'Book the engineer' }).click();
  await expect(page.getByLabel('Task details').getByRole('textbox', { name: 'Description' })).toHaveValue(/From email “Boiler”/);
});

test('AI: consent, preview of what is sent, and suggestions applied only on confirmation', async ({ page }) => {
  const seen = await fakeOllama(page, () => ({ subtasks: [{ title: 'Choose paint', minutes: 30 }, { title: 'Buy brushes', minutes: 20 }] }));
  await startFresh(page);
  await enableAi(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Paint the hallway');
  await input.press('Enter');
  await page.getByRole('listitem', { name: 'Paint the hallway' }).click();
  await page.getByRole('button', { name: 'AI assistant' }).click();
  await page.getByRole('menuitem', { name: 'Break into subtasks' }).click();
  const dialog = page.getByRole('dialog', { name: /Break down/ });
  await expect(dialog).toContainText('Sent to a model on your computer or network');
  await dialog.getByRole('button', { name: 'What will be sent' }).click();
  await expect(dialog).toContainText('Title: Paint the hallway');
  expect(seen).toHaveLength(0); // nothing sent before pressing Send
  await dialog.getByRole('button', { name: 'Send' }).click();
  await dialog.getByRole('checkbox').nth(1).uncheck();
  await dialog.getByRole('button', { name: 'Add 1 subtask' }).click();
  await expect(page.getByLabel('Task details').getByRole('listitem', { name: 'Choose paint' })).toBeVisible();
  await expect(page.getByLabel('Task details').getByRole('listitem', { name: 'Buy brushes' })).toHaveCount(0);
  expect(seen).toHaveLength(1);
});

test('webhook automation posts a signed payload when a task is completed', async ({ page }) => {
  const posts: { body: string; sig: string | undefined }[] = [];
  await page.route('http://localhost:9911/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    posts.push({ body: route.request().postData() ?? '', sig: route.request().headers()['x-focus-signature'] });
    await route.fulfill({ status: 200, headers: cors, body: 'ok' });
  });
  await startFresh(page);
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Home Assistant');
  await page.getByRole('textbox', { name: 'URL' }).fill('http://localhost:9911/api/webhook/focus');
  await page.getByLabel(/Signing secret/).fill('s3cret');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.goto('/#/automation/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('Tell HA');
  await page.getByRole('combobox', { name: 'Trigger' }).selectOption('task.completed');
  await page.getByRole('combobox', { name: 'Action' }).selectOption('webhook');
  await page.getByRole('combobox', { name: 'Webhook' }).selectOption({ label: 'Home Assistant' });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Replace smoke alarm battery');
  await input.press('Enter');
  await page.getByRole('checkbox', { name: 'Complete Replace smoke alarm battery' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(JSON.parse(posts[0]!.body)).toMatchObject({ event: 'task.completed', task: { title: 'Replace smoke alarm battery' } });
  expect(posts[0]!.sig).toMatch(/^sha256=[0-9a-f]{64}$/);
});

test('voice: explains online recognition, then dictation fills Quick Add and is parsed', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        setTimeout(() => {
          this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'Call the dentist tomorrow at 9am' }], { isFinal: true })] });
          this.onend?.();
        }, 50);
      }
      stop() {}
      abort() {}
    }
    // Replace both constructors (Chromium has the unprefixed one natively).
    const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
    w.webkitSpeechRecognition = FakeRecognition;
    w.SpeechRecognition = FakeRecognition;
  });
  await startFresh(page);
  await page.goto('/#/inbox');
  await quickAdd(page, '');
  await page.getByRole('button', { name: 'Dictate a task' }).click();
  await expect(page.getByText(/audio is sent over the internet/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('textbox', { name: /Task name/ })).toHaveValue('Call the dentist tomorrow at 9am');
  await expect(page.getByLabel('Recognised details')).toContainText('Tomorrow');
  await expect(page.getByLabel('Recognised details')).toContainText('09:00');
});
