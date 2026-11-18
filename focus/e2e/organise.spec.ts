import { expect, test } from '@playwright/test';
import { quickAdd, startFresh } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 17, 9, 0) });
  await startFresh(page);
});

async function add(page: import('@playwright/test').Page, text: string, title: string) {
  const input = await quickAdd(page, text);
  await input.press('Enter');
  await expect(page.getByRole('listitem', { name: title })).toBeVisible();
}

test('reschedule a deadline from its chip and from the task menu', async ({ page }) => {
  await page.goto('/#/inbox');
  await add(page, 'Renew insurance by 20 Nov', 'Renew insurance');
  const row = page.getByRole('listitem', { name: 'Renew insurance' });
  await row.getByRole('button', { name: /^Deadline / }).click();
  const picker = page.getByRole('dialog', { name: 'Deadline' });
  await picker.getByRole('menuitem', { name: /1 week later/ }).click();
  await expect(row.getByRole('button', { name: /^Deadline / })).toContainText('27 Nov');

  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Change deadline…' }).click();
  await page.getByRole('dialog', { name: 'Deadline' }).getByRole('menuitem', { name: /Tomorrow/ }).click();
  await expect(row.getByRole('button', { name: /^Deadline / })).toContainText('Tomorrow');
});

test('overdue tasks with only a deadline can be moved to today', async ({ page }) => {
  await page.goto('/#/inbox');
  await add(page, 'Return library books by 2026-11-10', 'Return library books');
  await page.goto('/#/today');
  await expect(page.getByRole('list', { name: 'Overdue tasks' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move to today' }).click();
  await expect(page.getByRole('list', { name: 'Overdue tasks' })).toHaveCount(0);
  await expect(page.getByRole('listitem', { name: 'Return library books' }).getByRole('button', { name: /^Deadline / })).toContainText('Today');
});

test('sort and group the Inbox, remembered after reload', async ({ page }) => {
  await page.goto('/#/inbox');
  await add(page, 'Banana bread @baking', 'Banana bread');
  await add(page, 'Apple pie @baking @errands p1', 'Apple pie');
  await add(page, 'Call the plumber', 'Call the plumber');
  await page.getByRole('button', { name: /Sort and group/ }).click();
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('name');
  const titles = () => page.getByRole('list', { name: 'Inbox tasks' }).getByRole('listitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  await expect.poll(titles).toEqual(['Apple pie', 'Banana bread', 'Call the plumber']);

  await page.getByRole('combobox', { name: 'Group by' }).selectOption('label');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'Inbox tasks: @baking' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Inbox tasks: @errands' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Inbox tasks: No label' }).getByRole('listitem')).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole('list', { name: 'Inbox tasks: @baking' })).toBeVisible();
  await page.getByRole('button', { name: /Sort and group/ }).click();
  await page.getByRole('button', { name: 'Reset to your order' }).click();
  await expect(page.getByRole('list', { name: 'Inbox tasks' })).toBeVisible();
});
