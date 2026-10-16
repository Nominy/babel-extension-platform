import { test, expect } from '../../src/test.mjs';
import { ready, saved, calls, SAVE } from './native-helpers.mjs';

test.use({ extensions: ['helper'], scenario: 'baseline' });

const ORIGINAL = 'Привет, это тестовая запись.';
const EDITED = 'Классический редактор сохраняет [смех] текст.';
const CLASSIC_ROW = 'tr[data-babel-classic-row][data-annotation-id="row-1"]';

// Exercise the installed extension and genuine recovered editor; the isolated
// scenario server owns only synthetic task/audio transport, never editor state.
test('Classic switches only on refresh and preserves native editing, Undo and saved text', async ({ page, babel }, testInfo) => {
  await ready(page);
  const options = await babel.options('helper');
  await options.locator('[data-role="editor-mode"]').selectOption('classic');
  await expect.poll(() => options.evaluate(async () => {
    const registrations = await chrome.scripting.getRegisteredContentScripts();
    return registrations.some(script => script.js?.some(file => file.endsWith('classic-performance-entry.js')));
  })).toBe(true);
  await expect(page.locator('section[data-annotation-id="row-1"]')).toBeVisible();
  await expect(page.locator(CLASSIC_ROW)).toHaveCount(0);
  await options.close();

  await page.reload();
  const editor = page.locator(CLASSIC_ROW).locator('textarea');
  await expect(editor).toHaveValue(ORIGINAL);
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(EDITED);
  await editor.press('Tab');
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations.find(row => row.id === 'row-1').content)).toBe(EDITED);
  await page.locator('button:has(svg.lucide-undo2)').click();
  await expect(editor).toHaveValue(ORIGINAL);
  await page.locator('button:has(svg.lucide-redo2)').click();
  await expect(editor).toHaveValue(EDITED);

  // Save while the textarea still owns a newer draft: no debounced tail may be
  // lost when a current native toolbar action consumes the Classic input.
  const finalText = EDITED + ' Последняя правка.';
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(finalText);
  const state = await saved(page, babel);
  const writes = calls(state, SAVE);
  expect(writes.at(-1).body.annotations.find(row => row.id === 'row-1').content).toBe(finalText);
  await expect(page.locator(CLASSIC_ROW).locator('textarea')).toHaveValue(finalText);
  await testInfo.attach('classic-editor', { body: await page.screenshot(), contentType: 'image/png' });
  await page.reload();
  await expect(page.locator(CLASSIC_ROW).locator('textarea')).toHaveValue(finalText);
});

test('Classic keeps diagnostic indicators and hover details with inline issues hidden', async ({ page, babel }) => {
  await ready(page);
  const options = await babel.options('helper');
  await options.locator('[data-role="editor-mode"]').selectOption('classic');
  await expect(options.locator('[data-role="status"]')).toContainText('ready for your next dashboard refresh');
  await options.close();
  await page.reload();
  const row = page.locator(CLASSIC_ROW);
  const indicator = row.locator('[data-babel-classic-lint-status]');
  await expect(page.locator('#babel-helper-hide-inline-issues')).toBeAttached();
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAccessibleName('No linter issues');
  const editor = row.locator('textarea');
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText('Привет — мир.');
  await editor.press('Tab');
  await expect(indicator).toHaveAccessibleName(/linter error/);
  await indicator.hover();
  await expect(page.getByRole('tooltip')).toContainText('ASCII hyphen');
});
