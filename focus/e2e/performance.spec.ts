import { expect, test } from '@playwright/test';

/** Builds a Focus JSON backup with `n` Inbox tasks, imported through the real onboarding flow. */
function bigBackup(n: number) {
  const now = new Date().toISOString();
  const tasks = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Inbox task ${i} ${['call', 'email', 'buy', 'fix'][i % 4]} something`,
    description: '', status: 'inbox', priority: (i % 4) + 1, created_at: now, updated_at: now, sort_order: i,
    scheduled_date: i % 3 ? null : '2026-12-01',
  }));
  return JSON.stringify({ format: 'focus-backup', formatVersion: 1, schemaVersion: 2, exportedAt: now, tables: { tasks } });
}

test('Inbox with 5,000 tasks renders and stays responsive', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'measured once');
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(bigBackup(5000)) });
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible({ timeout: 60_000 });

  const t0 = Date.now();
  await page.goto('/#/inbox');
  await expect(page.getByRole('listitem', { name: 'Inbox task 0 call something' })).toBeVisible({ timeout: 60_000 });
  const renderMs = Date.now() - t0;
  // Virtualised: only a window of rows is in the DOM, and scrolling reaches the end.
  expect(await page.locator('[data-task-row]').count()).toBeLessThan(120);
  await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByRole('listitem', { name: 'Inbox task 4999 fix something' })).toBeVisible();
  await page.locator('main').evaluate((el) => el.scrollTo(0, 0));

  const t1 = Date.now();
  await page.getByRole('checkbox', { name: 'Complete Inbox task 0 call something' }).click();
  await expect(page.getByRole('listitem', { name: 'Inbox task 0 call something' })).toHaveCount(0, { timeout: 30_000 });
  const completeMs = Date.now() - t1;
  console.log(`render ${renderMs} ms, complete ${completeMs} ms`);
  expect(renderMs).toBeLessThan(3000);
  expect(completeMs).toBeLessThan(1500);
});
