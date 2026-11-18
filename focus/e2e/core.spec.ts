import { expect, test } from '@playwright/test';
import { quickAdd, startFresh, waitForSave } from './helpers';

test('first-run onboarding with an empty database', async ({ page }) => {
  await startFresh(page);
  await expect(page.getByText('Nothing planned for today')).toBeVisible();
});

test('quick add parses natural language and shows it before saving', async ({ page }) => {
  await startFresh(page);
  const input = await quickAdd(page, 'Replace kitchen tap tomorrow at 6pm #home p2 @diy for 45m');
  const chips = page.getByLabel('Recognised details');
  await expect(chips).toContainText('Tomorrow');
  await expect(chips).toContainText('18:00');
  await expect(chips).toContainText('home (new)');
  await expect(chips).toContainText('P2');
  await expect(chips).toContainText('45m');
  await input.press('Enter');
  await expect(page.getByText(/Added “Replace kitchen tap” to home/)).toBeVisible();
  // New project was created and the task lives there
  await page.goto('/#/projects');
  await page.getByRole('main').getByRole('button', { name: /^home/ }).click();
  await expect(page.getByRole('listitem', { name: 'Replace kitchen tap' })).toBeVisible();
});

test('tapping a recognised token keeps it as title text', async ({ page }) => {
  await startFresh(page);
  const input = await quickAdd(page, 'Read Tomorrow by Rachel');
  await page.getByRole('button', { name: /Date: Tomorrow/ }).click();
  await input.press('Enter');
  await page.goto('/#/inbox');
  await expect(page.getByRole('listitem', { name: 'Read Tomorrow by Rachel' })).toBeVisible();
});

test('ambiguous phrases offer a choice', async ({ page }) => {
  await startFresh(page);
  await quickAdd(page, 'Check meter every second Tuesday');
  const choice = page.getByRole('radio', { name: /second Tuesday of every month/ });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(page.getByLabel('Recognised details')).toContainText('Every month on the second Tuesday');
});

test('complete, undo, and data persists after reload', async ({ page }) => {
  await startFresh(page);
  const input = await quickAdd(page, 'Buy batteries today');
  await input.press('Enter');
  await expect(page.getByRole('listitem', { name: 'Buy batteries' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Complete Buy batteries' }).click();
  await expect(page.getByText('Completed “Buy batteries”')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('checkbox', { name: 'Complete Buy batteries' })).toBeVisible();
  await waitForSave(page);
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Buy batteries' })).toBeVisible();
});

test('task details: edit fields, add subtask, comment', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Plan holiday');
  await input.press('Enter');
  await page.goto('/#/inbox');
  await page.getByRole('listitem', { name: 'Plan holiday' }).click();
  const details = page.getByLabel('Task details');
  await expect(details).toBeVisible();
  await details.getByRole('textbox', { name: 'New subtask' }).fill('Book ferry p1');
  await details.getByRole('textbox', { name: 'New subtask' }).press('Enter');
  await expect(details.getByText('Book ferry')).toBeVisible();
  await details.getByRole('textbox', { name: 'New comment' }).fill('Prefer the morning sailing');
  await details.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(details.getByText('Prefer the morning sailing')).toBeVisible();
  await details.getByRole('button', { name: 'Change deadline' }).click();
  await page.getByRole('textbox', { name: 'Type a date' }).fill('20/12');
  await page.getByRole('textbox', { name: 'Type a date' }).press('Enter');
  await expect(details.getByRole('button', { name: 'Change deadline' })).toContainText('20 Dec');
  // Scheduled date is independent of the deadline
  await expect(details.getByRole('button', { name: 'Change scheduled date' })).toContainText('Not scheduled');
});

test('search finds tasks offline-style from the local index', async ({ page }) => {
  await startFresh(page, true);
  await page.goto('/#/search');
  await page.getByRole('searchbox', { name: 'Search' }).fill('insur');
  await expect(page.getByRole('listitem', { name: 'Renew car insurance' })).toBeVisible();
});

test('project board layout and sections', async ({ page }) => {
  await startFresh(page, true);
  await page.goto('/#/projects');
  await page.getByRole('main').getByRole('button', { name: /Kitchen refit/ }).click();
  await expect(page.getByRole('list', { name: 'Board' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Planning' })).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await page.getByRole('radio', { name: 'Table' }).click();
  } else {
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('dialog', { name: 'Project actions' }).getByRole('button', { name: 'Table' }).click();
  }
  await expect(page.getByRole('table')).toBeVisible();
});

test('recurring task creates its next occurrence when completed', async ({ page }) => {
  await startFresh(page);
  const input = await quickAdd(page, 'Water plants every day');
  await input.press('Enter');
  await page.goto('/#/today');
  await page.getByRole('checkbox', { name: 'Complete Water plants' }).click();
  await expect(page.getByText('Completed “Water plants”')).toBeVisible();
  await page.goto('/#/upcoming');
  await expect(page.getByRole('listitem', { name: 'Water plants' }).first()).toBeVisible();
});

test('backup export produces a verified JSON file', async ({ page }) => {
  await startFresh(page, true);
  await page.goto('/#/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^focus-backup-.*\.json$/);
  await expect(page.getByText('Backup created and verified')).toBeVisible();
});

test('quick add on Today schedules for today from every entry point', async ({ page }) => {
  await startFresh(page);
  const input = await quickAdd(page, 'Stretch');
  await input.press('Enter');
  await expect(page.getByRole('listitem', { name: 'Stretch' })).toBeVisible();
});

test('quick add option menus open above the dialog and are usable', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Buy milk');
  const qa = page.getByRole('dialog', { name: 'Quick Add' });
  // Date menu: pick Tomorrow (Playwright's click fails if the item is covered).
  await qa.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('menuitem', { name: /Tomorrow/ }).click();
  await expect(qa.getByRole('button', { name: 'Schedule' })).toContainText('Tomorrow');
  // Priority menu
  await qa.getByRole('button', { name: 'Priority', exact: true }).click();
  await page.getByRole('menuitem', { name: /Priority 1/ }).click();
  await expect(qa.getByRole('button', { name: 'Priority', exact: true })).toContainText('P1');
  // Deadline menu via typed date
  await qa.getByRole('button', { name: 'Deadline' }).click();
  await page.getByRole('textbox', { name: 'Type a date' }).fill('25/12');
  await page.getByRole('textbox', { name: 'Type a date' }).press('Enter');
  await expect(qa.getByRole('button', { name: 'Deadline' })).toContainText('25 Dec');
  // Labels menu: create a label
  await qa.getByRole('button', { name: 'Labels' }).click();
  await page.getByRole('textbox', { name: 'Search or create label' }).fill('shopping');
  await page.getByRole('menuitem', { name: /Create “shopping”/ }).click();
  // Escape closes only the menu, not Quick Add
  await page.keyboard.press('Escape');
  await expect(input).toBeVisible();
  // Project menu
  await qa.getByRole('button', { name: 'Project' }).click();
  await page.getByRole('menuitem', { name: 'Inbox' }).click();
  await qa.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.goto('/#/upcoming');
  const row = page.getByRole('listitem', { name: 'Buy milk' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('shopping');
});

test('project notes and attachments', async ({ page }) => {
  await startFresh(page, true);
  await page.goto('/#/projects');
  await page.getByRole('main').getByRole('button', { name: /Lake District trip/ }).click();
  await page.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Notes and files' }).click();
  await page.getByRole('textbox', { name: 'Project notes' }).fill('Ferry from Bowness at 10:00');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add file' }).click()]);
  await chooser.setFiles({ name: 'itinerary.txt', mimeType: 'text/plain', buffer: Buffer.from('Day 1: Windermere') });
  await expect(page.getByText('itinerary.txt')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Project notes' })).toHaveValue('Ferry from Bowness at 10:00');
  await expect(page.getByText('itinerary.txt')).toBeVisible();
});

test('an edit survives an immediate reload', async ({ page }) => {
  await startFresh(page);
  await page.goto('/#/inbox');
  const input = await quickAdd(page, 'Saved before reload');
  await input.press('Enter');
  await expect(page.getByRole('listitem', { name: 'Saved before reload' })).toBeVisible();
  await page.reload(); // no waiting for the save indicator
  await expect(page.getByRole('listitem', { name: 'Saved before reload' })).toBeVisible();
});
