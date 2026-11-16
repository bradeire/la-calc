import { expect, test, type Page } from '@playwright/test';
import { quickAdd, startFresh } from './helpers';
import { startRelay } from './relay';

test.describe.configure({ mode: 'serial' });

async function addTask(page: Page, text: string) {
  await page.goto('/#/inbox');
  const input = await quickAdd(page, text);
  await input.press('Enter');
  await page.keyboard.press('Escape');
}

test('two devices stay in sync through the encrypted relay', async ({ browser }) => {
  test.skip(test.info().project.name !== 'desktop', 'one run is enough: it uses two browser contexts');
  const relay = await startRelay();
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await relay.attach(desktop);
  await relay.attach(phone);
  const d = await desktop.newPage();
  const p = await phone.newPage();
  await startFresh(d);
  await startFresh(p);

  // Desktop: a task, then set up sync and read the key.
  await addTask(d, 'Book boiler service #Home p2');
  await d.goto('/#/settings');
  await d.getByRole('button', { name: 'Set up on this device' }).click();
  await d.getByLabel('Relay address').fill('https://relay.test');
  await d.getByRole('button', { name: 'Create sync key' }).click();
  await expect(d.getByText('Sync is on for this device.')).toBeVisible();
  await expect(d.getByRole('img', { name: /QR code to join sync/ })).toBeVisible();
  if (process.env.SHOT) await d.screenshot({ path: process.env.SHOT });
  const key = (await d.locator('code.font-semibold').textContent())!.trim();
  expect(key).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
  await d.getByRole('button', { name: 'Done' }).click();

  // Phone: join with the key; the desktop task arrives.
  await p.goto('/#/settings');
  await p.getByRole('button', { name: 'Join from another device' }).click();
  await p.getByLabel('Relay address').fill('https://relay.test');
  await p.getByLabel('Sync key (from your other device)').fill(key);
  await p.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(p.getByText('Joined: this device is now in sync')).toBeVisible();
  await p.goto('/#/projects');
  await p.getByRole('main').getByText('Home').first().click();
  await expect(p.getByRole('listitem', { name: 'Book boiler service' })).toBeVisible();

  // Phone adds a task; desktop picks it up on its next sync (here: when it regains focus).
  await addTask(p, 'Pick up dry cleaning');
  await p.goto('/#/settings');
  await p.getByRole('button', { name: 'Sync now' }).click();
  await expect(p.getByText('Synced', { exact: true })).toBeVisible();
  await d.goto('/#/settings');
  await d.getByRole('button', { name: 'Sync now' }).click();
  await d.goto('/#/inbox');
  await expect(d.getByRole('listitem', { name: 'Pick up dry cleaning' })).toBeVisible();

  // The relay only ever saw ciphertext.
  expect(relay.stored()).not.toMatch(/boiler|dry cleaning/i);
  await desktop.close();
  await phone.close();
});
