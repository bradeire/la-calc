import { expect, type Page } from '@playwright/test';

export async function startFresh(page: Page, demo = false) {
  await page.goto('/');
  await page.getByText(demo ? 'Explore with demonstration data' : 'Start fresh').click();
  await page.getByRole('button', { name: /Get started/ }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
}

export async function quickAdd(page: Page, text: string) {
  const isMobile = (page.viewportSize()?.width ?? 1000) < 1024;
  if (isMobile) await page.getByRole('button', { name: 'Add task', exact: true }).last().click();
  else await page.keyboard.press('q');
  const input = page.getByRole('textbox', { name: /Task name/ });
  await expect(input).toBeVisible();
  await input.fill(text);
  return input;
}

export async function waitForSave(page: Page) {
  // The save indicator reports when everything is persisted to IndexedDB.
  await page.waitForFunction(() => !document.querySelector('[aria-label="Saving…"]'));
  await page.waitForTimeout(400);
}
