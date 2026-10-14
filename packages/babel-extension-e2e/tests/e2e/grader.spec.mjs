import { test, expect } from '../../src/test.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { repositoryDir } from '../../src/build.mjs';
import { ready, feedbackPanel, feedbackCategoryKeys, editText, selectText, readText, readRawTexts, text, saved } from './native-helpers.mjs';

const prefixes = feedbackCategoryKeys;
async function openFeedback(page, babel) {
  await babel.reset('review');
  const url = new URL(page.url()); url.searchParams.set('displayFeedback', 'true');
  await page.goto(url.href);
  await ready(page);
  await expect(page.getByText('L1 Feedback Form', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grade review', exact: true })).toBeVisible();
}

test.describe('Review Grader addon', () => {
  test.use({ extensions: ['review', 'grader'] });
  test('rejects grades after the transcript changes', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await openFeedback(page, babel);
    // Establish existing ratings explicitly; the captured native form starts unrated.
    for (const prefix of prefixes) await feedbackPanel(page).locator(`label[for="${prefix}-1"]`).click();
    const keySettings = await babel.options('review');
    await keySettings.getByRole('textbox', { name: 'OpenRouter API key' }).fill('sk-or-grader-browser-fixture');
    await keySettings.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(keySettings.getByText('Saved key ending ture.', { exact: false })).toBeVisible();
    await keySettings.close();
    await expect(page.getByRole('button', { name: 'OpenRouter', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await feedbackPanel(page).getByRole('button').first().click();
    const state = await babel.state();
    await editText(page, 0, `${state.action.annotations[0].content} Изменено.`);
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply grades', exact: true }).click();
    await expect(dialog).toContainText('The transcript changed since grading.');
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeDisabled();
    for (const prefix of prefixes) await expect(page.locator(`[id="${prefix}-1"]`)).toHaveAttribute('aria-checked', 'true');
  });
  test('handles backend failures and keeps apply disabled', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await openFeedback(page, babel);
    const keySettings = await babel.options('review');
    await keySettings.getByRole('textbox', { name: 'OpenRouter API key' }).fill('sk-or-grader-browser-fixture');
    await keySettings.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(keySettings.getByText('Saved key ending ture.', { exact: false })).toBeVisible();
    await keySettings.close();
    await expect(page.getByRole('button', { name: 'OpenRouter', exact: true })).toHaveCount(0);
    await babel.control({ routes: { '/api/review/grade': { error: { status: 404, message: 'Not deployed' } } } });
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog).toContainText('does not support Review Grader yet');
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeDisabled();
  });
  test('generates, previews, and applies grades while preserving notes', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await openFeedback(page, babel);
    const keySettings = await babel.options('review');
    await keySettings.getByRole('textbox', { name: 'OpenRouter API key' }).fill('sk-or-grader-browser-fixture');
    await keySettings.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(keySettings.getByText('Saved key ending ture.', { exact: false })).toBeVisible();
    await keySettings.close();
    await expect(page.getByRole('button', { name: 'OpenRouter', exact: true })).toHaveCount(0);
    const notes = feedbackPanel(page).getByPlaceholder('Provide specific feedback...');
    await notes.first().fill('Keep this reviewer note.');
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('combobox')).toHaveCount(5);
    await dialog.getByRole('combobox', { name: 'Word Accuracy grade', exact: true }).selectOption('2');
    await mkdir(path.join(repositoryDir, 'frontend-preview'), { recursive: true });
    await page.screenshot({ path: path.join(repositoryDir, 'frontend-preview/review-grader.png') });
    await dialog.getByRole('button', { name: 'Apply grades', exact: true }).click();
    await expect(dialog).toContainText('Grades applied.');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const [index, prefix] of prefixes.entries()) {
      const score = index === 0 ? 2 : index % 3 + 1;
      await expect(page.locator(`[id="${prefix}-${score}"]`)).toHaveAttribute('aria-checked', 'true');
    }
    await expect(notes.first()).toHaveValue('Keep this reviewer note.');
    const state = await babel.state();
    expect(state.submissions ?? []).toHaveLength(0);
  });
});

test.describe('Review Grader dependency', () => {
  test.use({ extensions: ['grader'] });
  test('explains the missing Review Helper without requesting grades', async ({ page, babel }) => {
    await openFeedback(page, babel);
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog).toContainText('Install or reload the updated Babel Review Helper');
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeDisabled();
  });
});

test.describe('all four installed extensions', () => {
  test.use({ scenario: 'review', extensions: ['helper', 'gold', 'review', 'grader'] });
  test('Helper edits and Gold apply invalidate Grader results without losing native feedback', async ({ page, babel }) => {
    await babel.setExtensionSettings('gold', { mode: 'advanced', audioInputEnabled: false,
      l0ReplacementPreviewEnabled: false, localModelsEnabled: false });
    await ready(page);
    await expect(page.getByRole('button', { name: 'Website Appearance', exact: true })).toBeVisible();
    await editText(page, 0, 'У меня пять книг.');
    await selectText(text(page, 0), 7, 11);
    await page.keyboard.press('5');
    await expect.poll(() => readText(text(page, 0))).toBe('У меня 5 {СКАЗ: пять} книг.');
    await text(page, 0).press('Enter');

    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const notes = feedbackPanel(page).getByPlaceholder('Provide specific feedback...');
    await notes.first().fill('Keep this reviewer note across draft application.');
    for (const prefix of prefixes) await feedbackPanel(page).locator(`label[for="${prefix}-1"]`).click();
    const keySettings = await babel.options('review');
    await keySettings.getByRole('textbox', { name: 'OpenRouter API key' }).fill('sk-or-grader-browser-fixture');
    await keySettings.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect.poll(() => keySettings.evaluate(async () =>
      (await chrome.storage.local.get('babel-review-openrouter-key-v1'))['babel-review-openrouter-key-v1']
    )).toBe('sk-or-grader-browser-fixture');
    await keySettings.close();
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await feedbackPanel(page).getByRole('button').first().click();

    await page.locator('#babel-gold-drafting-magic-button').click();
    await expect(page.getByRole('button', { name: 'Apply Draft', exact: true })).toBeEnabled({ timeout: 60_000 });
    const draft = (await babel.state()).calls.findLast(call =>
      call.path.startsWith('/api/draft/generate') && Array.isArray(call.response?.draftRows));
    expect(draft).toBeDefined();
    const output = new Map(draft.response.draftRows.map(row => [row.rowId, row.rewrittenText]));
    const expected = draft.body.rows.map(row => output.get(row.rowId));
    await page.getByRole('button', { name: 'Apply Draft', exact: true }).click();
    await expect(page.locator('#babel-gold-drafting-overlay')).toBeHidden();
    await expect.poll(() => readRawTexts(page)).toEqual(expected);
    for (let index = 0; index < expected.length; index++) {
      await expect.poll(() => readText(text(page, index))).toBe(expected[index]);
    }
    const persisted = await saved(page, babel);
    expect(persisted.action.annotations.map(row => row.content)).toEqual(expected);

    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply grades', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const prefix of prefixes) await expect(feedbackPanel(page).locator(`#${prefix}-1`)).toBeChecked();
    await expect(notes.first()).toHaveValue('Keep this reviewer note across draft application.');
    expect((await babel.state()).submissions).toEqual([]);
    await test.info().attach('all-four-extensions', {
      body: await page.screenshot({
        path: `${test.info().project.outputDir}/all-four-extensions.png`,
        fullPage: true,
      }),
      contentType: 'image/png',
    });
  });
});
