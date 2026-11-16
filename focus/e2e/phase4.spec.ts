import { expect, test } from '@playwright/test';
import { quickAdd, startFresh } from './helpers';

test('insights reflect real completions, goals and customisation', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 9, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  for (const t of ['Water plants #Home', 'Pay rent', 'Book MOT']) {
    const input = await quickAdd(page, t);
    await input.press('Enter');
    await page.keyboard.press('Escape');
  }
  await page.getByRole('checkbox', { name: 'Complete Pay rent' }).click();
  await page.getByRole('checkbox', { name: 'Complete Book MOT' }).click();

  await page.goto('/#/insights');
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary.getByText('Completed', { exact: true }).locator('..')).toContainText('2');
  await expect(summary.getByText('Created', { exact: true }).locator('..')).toContainText('3');

  // Every chart has a table alternative with the same numbers.
  const chart = page.getByRole('region', { name: 'Created and completed' });
  await chart.getByRole('button', { name: /as table/ }).click();
  await expect(chart.getByRole('row', { name: /Mon 16 Nov 2 3/ })).toBeVisible();

  // Goals: a daily target of 2 is met today.
  await page.getByRole('region', { name: 'Goals and streaks' }).getByRole('button', { name: 'Set goals' }).click();
  await page.getByLabel('Tasks per day').fill('2');
  await page.getByRole('button', { name: 'Save' }).click();
  const goals = page.getByRole('region', { name: 'Goals and streaks' });
  await expect(goals.getByText('2 of 2')).toBeVisible();
  await expect(goals.getByText(/1 day/)).toBeVisible();

  // Customise: hide a widget; the choice persists.
  await page.getByRole('button', { name: 'Customise' }).click();
  await page.getByRole('switch', { name: 'Show Priority distribution' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('region', { name: 'Priority distribution' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Priority distribution' })).toHaveCount(0);
});

test('time log: manual time appears in reports and can be corrected', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 15, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Sort garage');
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await page.getByRole('listitem', { name: 'Sort garage' }).click();
  await page.getByLabel('Task details').getByRole('button', { name: 'Time', exact: true }).click();
  await page.getByLabel('Add minutes manually').fill('50');
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await page.goto('/#/time');
  await expect(page.getByRole('button', { name: 'Sort garage' })).toBeVisible();
  await expect(page.getByText('50m').first()).toBeVisible();
  await page.getByRole('button', { name: 'Correct entry' }).click();
  await page.getByLabel('Minutes').fill('35');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('35m in this period')).toBeVisible();
  await page.goto('/#/insights');
  await expect(page.getByRole('region', { name: 'Summary' }).getByText('35m')).toBeVisible();
});

test('a timer left running for hours asks whether you are still working', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 9, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Tax return');
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await page.getByRole('listitem', { name: 'Tax return' }).click();
  await page.getByLabel('Task details').getByRole('button', { name: 'Time', exact: true }).click();
  await page.getByRole('button', { name: /Start timer/ }).click();
  await page.clock.fastForward('04:01:00');
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Are you still working on it?' })).toBeVisible();
  await page.getByRole('button', { name: 'Fix the end time' }).click();
  await page.getByLabel('Or stop at').fill('10:30');
  await page.getByRole('button', { name: 'Stop at this time' }).click();
  await expect(page.getByText('1h 30m in this period')).toBeVisible();
});
