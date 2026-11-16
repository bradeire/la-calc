import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { quickAdd, startFresh, waitForSave } from './helpers';

test('works offline after the first visit', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'service worker behaviour is the same on both');
  await startFresh(page);
  const input = await quickAdd(page, 'Offline proof');
  await input.press('Enter');
  await waitForSave(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Offline proof' })).toBeVisible();
  await page.goto('/#/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await context.setOffline(false);
});

const pages = ['/#/today', '/#/inbox', '/#/upcoming', '/#/calendar', '/#/projects', '/#/labels', '/#/search', '/#/settings', '/#/trash', '/#/filters', '/#/filter/new', '/#/automations', '/#/automation/new'];

test('no serious accessibility violations on main screens (light and dark)', async ({ page }) => {
  test.setTimeout(90_000);
  await startFresh(page, true);
  const problems: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of pages) {
      await page.goto(path);
      await page.waitForTimeout(150);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        problems.push(`${scheme} ${path} ${v.id}: ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.nodes[0]?.failureSummary?.split('\n')[1] ?? ''}`);
      }
    }
  }
  // Task detail and Quick Add
  await page.goto('/#/projects');
  await page.getByRole('main').getByRole('button', { name: /Work/ }).click();
  await page.getByRole('listitem', { name: 'Draft Q4 report' }).click();
  for (const v of (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical'))
    problems.push(`detail ${v.id}: ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
  console.log(problems.join('\n'));
  expect(problems).toEqual([]);
});
