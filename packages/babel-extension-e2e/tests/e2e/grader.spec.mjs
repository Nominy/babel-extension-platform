import { test, expect } from '../../src/test.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { repositoryDir } from '../../src/build.mjs';

const prefixes = ['wordAccuracy', 'timestampAccuracy', 'punctuationFormatting', 'tagsEmphasis', 'segmentation'];
async function openFeedback(page, babel) {
  await babel.reset('review');
  const url = new URL(page.url()); url.searchParams.set('displayFeedback', 'true');
  await page.goto(url.href);
  await expect(page.getByText('L1 Feedback Form', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grade review', exact: true })).toBeVisible();
}

test.describe('Review Grader addon', () => {
  test.use({ extensions: ['review', 'grader'] });
  test('rejects grades after the transcript changes', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await openFeedback(page, babel);
    await page.getByRole('button', { name: 'Grade review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Babel Review Grader', exact: true });
    await dialog.getByRole('button', { name: 'Generate grades', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeEnabled();
    const state = await babel.state();
    const changed = { ...state.action, annotations: state.action.annotations.map((row, i) => i === 0 ? { ...row, content: row.content + ' Changed.' } : row) };
    await babel.control({ procedures: { 'transcriptions.getReviewActionDataById': { response: changed, times: 1 } } });
    await dialog.getByRole('button', { name: 'Apply grades', exact: true }).click();
    await expect(dialog).toContainText('The transcript changed since grading.');
    await expect(dialog.getByRole('button', { name: 'Apply grades', exact: true })).toBeDisabled();
    for (const prefix of prefixes) await expect(page.locator(`[id="${prefix}-1"]`)).toHaveAttribute('aria-checked', 'true');
  });
  test('handles backend failures and keeps apply disabled', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await openFeedback(page, babel);
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
    const notes = page.locator('textarea[placeholder="Provide specific feedback..."]');
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
