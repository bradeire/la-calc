import { expect, test } from '@playwright/test';
import { quickAdd, startFresh } from './helpers';

const isDesktop = (page: import('@playwright/test').Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test('filters: preset, visual builder and query stay in sync', async ({ page }) => {
  await startFresh(page, true);
  await page.goto('/#/filters');
  await page.getByRole('button', { name: /Priority 1/ }).click();
  await expect(page.getByRole('heading', { name: 'Priority 1', level: 1 })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Renew car insurance' })).toBeVisible();

  await page.goto('/#/filter/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('Home this month');
  const query = page.getByRole('textbox', { name: /Advanced query/ });
  await query.fill('#Home & deadline:this-month');
  // The visual builder reflects the parsed query.
  await expect(page.getByRole('combobox', { name: 'Field' }).first()).toHaveValue('project');
  await expect(page.getByLabel('Filter preview').getByRole('listitem', { name: 'Renew car insurance' })).toBeVisible();
  await query.fill('#Nowhere');
  await expect(page.getByRole('alert')).toContainText('No project called');
  await query.fill('p1 | overdue');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home this month', level: 1 })).toBeVisible();
});

test('dependencies: blocked badge and confirmation before completing', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/inbox');
  for (const t of ['Get quotes', 'Choose fitter']) {
    const input = await quickAdd(page, t);
    await input.press('Enter');
    await expect(page.getByRole('listitem', { name: t })).toBeVisible();
  }
  await page.getByRole('listitem', { name: 'Choose fitter' }).click();
  const details = page.getByLabel('Task details');
  await details.getByRole('button', { name: /Waiting on/ }).click();
  await page.getByRole('menuitem', { name: 'Get quotes' }).click();
  await expect(details.getByText('Blocked by 1 unfinished task')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: 'Choose fitter' })).toContainText('Blocked');
  await page.getByRole('checkbox', { name: 'Complete Choose fitter' }).click();
  await expect(page.getByText(/is waiting on 1 unfinished task/)).toBeVisible();
  await page.getByRole('button', { name: 'Complete anyway' }).click();
  await expect(page.getByRole('listitem', { name: 'Choose fitter' })).toHaveCount(0);
});

test('templates: create a project from the holiday template', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/projects');
  await page.getByRole('button', { name: 'From template' }).click();
  await page.getByRole('radio', { name: /Holiday planning/ }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Lisbon');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Book accommodation' })).toContainText('Blocked');
});

test('calendar: week view, click a slot to add, drag a block to move it', async ({ page }) => {
  test.skip(!isDesktop(page), 'mouse drag on desktop; touch uses press-and-hold');
  await page.clock.install({ time: new Date(2026, 10, 16, 8, 0) });
  await startFresh(page);
  await page.goto('/#/calendar');
  await page.getByRole('radio', { name: 'Week' }).click();
  const col = page.locator('[data-day="2026-11-16"]');
  // Bring 10:00 into view, then click it (bounding box is already scroll-adjusted).
  await col.evaluate((el) => el.closest('.overflow-y-auto')!.scrollTo(0, 9 * 48));
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 10 * 48 + 5);
  const input = page.getByRole('textbox', { name: /Task name/ });
  await input.fill('Calendar slot task');
  await expect(page.getByRole('button', { name: 'Schedule' })).toContainText('10:00');
  await input.press('Enter');
  const block = page.getByRole('button', { name: /Calendar slot task, 10:00/ });
  await expect(block).toBeVisible();
  // Drag down one hour.
  const b = (await block.boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + 5 + 24, { steps: 4 });
  await page.mouse.move(b.x + 10, b.y + 5 + 48, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /Calendar slot task, 11:00/ })).toBeVisible();
  // Resize: drag the lower edge down 30 minutes.
  const moved = page.getByRole('button', { name: /Calendar slot task, 11:00/ });
  const m = (await moved.boundingBox())!;
  await page.mouse.move(m.x + 10, m.y + m.height - 2);
  await page.mouse.down();
  await page.mouse.move(m.x + 10, m.y + m.height - 2 + 24, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /Calendar slot task, 11:00, 1h/ })).toBeVisible();
});

test('reminders fire in-app at the right time and can be snoozed', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 9, 0) });
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Call the garage today at 9:30');
  await input.press('Enter');
  await page.getByRole('listitem', { name: 'Call the garage' }).click();
  const details = page.getByLabel('Task details');
  await details.getByRole('button', { name: /Reminders/ }).click();
  await details.getByRole('combobox', { name: 'Add relative reminder' }).selectOption({ label: '10 minutes before' });
  await expect(page.getByRole('alertdialog', { name: /Reminder: Call the garage/ })).toHaveCount(0);
  await page.clock.fastForward('20:30');
  const alert = page.getByRole('alertdialog', { name: /Reminder: Call the garage/ });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '10 min' }).click();
  await expect(alert).toHaveCount(0);
  await page.clock.fastForward('10:30');
  await expect(page.getByRole('alertdialog', { name: /Reminder: Call the garage/ })).toBeVisible();
});

test('planning: overloaded day suggestion can be accepted', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 16, 8, 0) }); // Monday
  await startFresh(page);
  await page.goto('/#/inbox');
  for (const t of ['Big report today for 7h p1', 'Tidy desk today for 2h p4']) {
    const input = await quickAdd(page, t);
    await input.press('Enter');
  }
  await page.goto('/#/upcoming');
  await page.getByRole('button', { name: /Review plan/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Review plan' });
  await expect(dialog).toContainText('over capacity');
  await expect(dialog.getByText('Tidy desk')).toBeVisible();
  await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('Task rescheduled')).toBeVisible();
});
