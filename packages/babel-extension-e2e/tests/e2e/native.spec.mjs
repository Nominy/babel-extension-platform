import { test, expect } from '../../src/test.mjs';
import {
  TEXT, SAVE, SUBMIT, rows, row, text, ready, editText, history, rowMenu,
  saved, calls, audio, audioReady, regionTimes, waveformRegion, dragAcross,
  feedbackCategoryKeys, feedbackComment, OTHER_FEEDBACK, feedbackDraftResponses, submitReview,
  openFeedback, seedFeedbackDraft, coldFeedbackReload, expectFeedbackRestored,
} from './native-helpers.mjs';

// Native coverage deliberately runs without any extension altering the editor.
test.use({ extensions: [], scenario: 'baseline' });

const ORIGINAL = 'Привет, это тестовая запись.';
const EDITED = 'Привет, это исправленная запись.';
const ACTION = '22222222-2222-4222-8222-222222222222';

test('baseline loads the recovered two-speaker transcript and real local waveforms', async ({ page, babel }) => {
  await ready(page);
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
  await expect(text(page, 3)).toHaveValue('Продолжим проверку вместе.');
  await expect(page.getByRole('heading', { name: 'Speaker 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Speaker 2', exact: true })).toBeVisible();
  await audioReady(page);
  await expect(waveformRegion(page, 'row-1')).toBeVisible();
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5, trackId: 'speaker-1' });
  await expect.poll(() => regionTimes(page, 'row-4')).toMatchObject({ start: 8.5, end: 10, trackId: 'speaker-2' });
  const state = await babel.state();
  expect(state.action.annotations.map(annotation => annotation.content)).toEqual(await page.locator(TEXT).evaluateAll(elements => elements.map(element => element.value)));
  expect(calls(state, SAVE)).toHaveLength(0);
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Play/Pause');
  await expect(page.getByRole('dialog')).toContainText('Split segment at click position');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('textarea blur commits one undoable edit, redo restores it, and save survives refetch', async ({ page, babel }) => {
  await ready(page);
  await editText(page, 0, EDITED);
  await expect(page.getByRole('button', { name: 'Save progress', exact: true })).toBeVisible();
  expect((await babel.state()).action.annotations[0].content).toBe(ORIGINAL);
  await history(page, 'undo');
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
  await history(page, 'redo');
  await expect(text(page, 0)).toHaveValue(EDITED);
  const state = await saved(page, babel);
  expect(state.action.annotations.find(annotation => annotation.id === 'row-1').content).toBe(EDITED);
  expect(calls(state, SAVE)).toHaveLength(1);
  await page.reload();
  await ready(page);
  await expect(text(page, 0)).toHaveValue(EDITED);
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
});

test('timestamp validation refuses reversed bounds, Escape cancels, and commit updates the waveform', async ({ page, babel }) => {
  await ready(page);
  await audioReady(page);
  const start = row(page, 0).locator('td').nth(2);
  const initial = await start.innerText();
  await start.dblclick();
  const input = start.getByPlaceholder('mm:ss.xx');
  await input.fill('00:04.00');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await expect(start.locator('span.text-red-500')).toBeVisible();
  expect(await regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
  await input.press('Escape');
  await expect(start).toHaveText(initial);
  await start.dblclick();
  await input.fill('not-a-time');
  await text(page, 0).click();
  await expect(start).toHaveText(initial);
  await start.dblclick();
  await input.fill('00:00.60');
  await input.press('Enter');
  await expect(start).toContainText('00:00.60');
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.6, end: 2.5 });
  await saved(page, babel);
  expect((await babel.state()).action.annotations.find(annotation => annotation.id === 'row-1').startTimeInSeconds).toBe(0.6);
  await history(page, 'undo');
  await expect(start).toHaveText(initial);
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
});

test('create, change speaker, merge, and delete keep table and waveform in sync with undo', async ({ page, babel }) => {
  await ready(page);
  await audioReady(page);
  await rowMenu(page, 0, 'Add Segment Below');
  const dialog = page.getByRole('dialog', { name: 'Add New Region' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Start Time (mm:ss.xx)', { exact: true }).fill('00:02.60');
  await dialog.getByLabel('Start Time (mm:ss.xx)', { exact: true }).press('Tab');
  await dialog.getByLabel('End Time (mm:ss.xx)', { exact: true }).fill('00:02.90');
  await dialog.getByLabel('End Time (mm:ss.xx)', { exact: true }).press('Tab');
  await dialog.getByLabel('Text', { exact: true }).fill('Новая реплика.');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(text(page, 1)).toHaveValue('Новая реплика.');
  const createdState = await saved(page, babel);
  const created = createdState.action.annotations.find(annotation => annotation.content === 'Новая реплика.');
  expect(created).toMatchObject({ processedRecordingId: 'speaker-1', startTimeInSeconds: 2.6, endTimeInSeconds: 2.9 });
  await expect.poll(() => regionTimes(page, created.id)).toMatchObject({ start: 2.6, end: 2.9, trackId: 'speaker-1' });
  await row(page, 1).locator('td').nth(1).dblclick();
  await page.getByRole('option', { name: 'Speaker 2', exact: true }).click();
  await expect(row(page, 1).locator('td').nth(1)).toHaveText('Speaker 2');
  await expect.poll(() => regionTimes(page, created.id)).toMatchObject({ trackId: 'speaker-2' });
  await history(page, 'undo');
  await expect.poll(() => regionTimes(page, created.id)).toMatchObject({ trackId: 'speaker-1' });
  await rowMenu(page, 1, 'Merge With Above');
  await expect(rows(page)).toHaveCount(4);
  await expect(text(page, 0)).toHaveValue(`${ORIGINAL} Новая реплика.`);
  await expect.poll(() => regionTimes(page, created.id)).toMatchObject({ start: 0.5, end: 2.9 });
  await expect(waveformRegion(page, 'row-1')).toHaveCount(0);
  await history(page, 'undo');
  await expect(rows(page)).toHaveCount(5);
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
  await rowMenu(page, 1, 'Delete');
  await expect(rows(page)).toHaveCount(4);
  await expect(waveformRegion(page, created.id)).toHaveCount(0);
  await history(page, 'undo');
  await expect(text(page, 1)).toHaveValue('Новая реплика.');
  await expect.poll(() => regionTimes(page, created.id)).toMatchObject({ start: 2.6, end: 2.9 });
});

test('waveform modifier-click splits a segment with a bounded gap and undo restores its identity', async ({ page, babel }) => {
  await ready(page);
  await audioReady(page);
  const originalRegion = waveformRegion(page, 'row-1');
  await originalRegion.scrollIntoViewIfNeeded();
  const box = await originalRegion.boundingBox();
  expect(box.width).toBeGreaterThan(20);
  await originalRegion.click({ position: { x: box.width / 2, y: box.height / 2 }, modifiers: ['ControlOrMeta'] });
  await expect(rows(page)).toHaveCount(5);
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
  await expect(text(page, 1)).toHaveValue(ORIGINAL);
  const state = await saved(page, babel);
  const split = state.action.annotations.filter(annotation => annotation.content === ORIGINAL).sort((a, b) => a.startTimeInSeconds - b.startTimeInSeconds);
  expect(split).toHaveLength(2);
  expect(split[0].startTimeInSeconds).toBe(0.5);
  expect(split[1].endTimeInSeconds).toBe(2.5);
  expect(split[0].endTimeInSeconds).toBeGreaterThan(0.5);
  expect(split[1].startTimeInSeconds).toBeLessThan(2.5);
  expect(split[1].startTimeInSeconds - split[0].endTimeInSeconds).toBeCloseTo(0.1, 4);
  expect(split.map(annotation => annotation.processedRecordingId)).toEqual(['speaker-1', 'speaker-1']);
  for (const annotation of split) {
    await expect.poll(() => regionTimes(page, annotation.id)).toMatchObject({ start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds });
  }
  await expect(originalRegion).toHaveCount(0);
  await history(page, 'undo');
  await expect(rows(page)).toHaveCount(4);
  await expect(originalRegion).toBeVisible();
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
  await history(page, 'redo');
  await expect(rows(page)).toHaveCount(5);
  await expect(originalRegion).toHaveCount(0);
});

test('real WebAudio transport plays, pauses, seeks both lanes, and applies playback rate', async ({ page }) => {
  await ready(page);
  await audioReady(page);
  await row(page, 0).locator('td').first().click();
  await expect.poll(async () => (await audio(page)).map(track => track.currentTime)).toEqual([0.5, 0.5]);
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause all tracks', exact: true })).toBeVisible();
  await expect.poll(async () => (await audio(page)).every(track => track.playing && track.currentTime > 0.8)).toBe(true);
  await page.getByRole('button', { name: 'Pause all tracks', exact: true }).click();
  const paused = await audio(page);
  expect(paused.every(track => !track.playing)).toBe(true);
  // Exercise unrelated UI while paused, before changing the transport's rate.
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await audio(page);
  after.forEach((track, index) => {
    expect(track.playing).toBe(false);
    expect(track.currentTime).toBeCloseTo(paused[index].currentTime, 3);
  });
  await page.getByRole('combobox').filter({ hasText: /^1x$/ }).click();
  await page.getByRole('option', { name: '1.5x', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.playbackRate)).toEqual([1.5, 1.5]);
  await row(page, 2).locator('td').first().click();
  await expect.poll(async () => (await audio(page)).map(track => track.currentTime)).toEqual([5.5, 5.5]);
  await page.getByRole('button', { name: 'Jump forward 5 seconds', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.currentTime)).toEqual([8.5, 8.5]);
  await page.getByRole('button', { name: 'Jump back 5 seconds', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.currentTime)).toEqual([5.5, 5.5]);
});

test('native Mute controls silence only their own lane and zoom/collapse preserve regions', async ({ page }) => {
  await ready(page);
  await audioReady(page);
  // The captured UI labels its Mute button "Solo track"; its real behavior is lane mute.
  await page.getByRole('button', { name: 'Solo track', exact: true }).first().click();
  await expect.poll(async () => (await audio(page)).map(track => track.volume)).toEqual([0, 1]);
  await page.getByRole('button', { name: 'Unsolo track', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.volume)).toEqual([1, 1]);
  const region = waveformRegion(page, 'row-1');
  const before = await region.boundingBox();
  const zoom = page.getByRole('slider');
  // The toolbar horizontal slider is first; each track's vertical slider follows.
  await zoom.first().focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('PageUp');
  await expect.poll(async () => (await region.boundingBox()).width).not.toBeCloseTo(before.width, 0);
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
  await page.getByRole('button', { name: 'Hide track', exact: true }).first().click();
  await expect(region).toBeHidden();
  await page.getByRole('button', { name: 'Show track', exact: true }).click();
  await expect(region).toBeVisible();
  await expect.poll(() => regionTimes(page, 'row-1')).toMatchObject({ start: 0.5, end: 2.5 });
});

test('loop drag and resize constrain genuine playback; keyboard toggle and Escape clear it', async ({ page }) => {
  await ready(page);
  await audioReady(page);
  const loopBar = page.locator('div.cursor-crosshair');
  await dragAcross(page, loopBar, 0.1, 0.3);
  const start = page.locator('[data-handle="start"]');
  const end = page.locator('[data-handle="end"]');
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();
  const endBefore = await end.boundingBox();
  await page.mouse.move(endBefore.x + endBefore.width / 2, endBefore.y + endBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(endBefore.x - 25, endBefore.y + endBefore.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await end.boundingBox()).x).toBeLessThan(endBefore.x - 15);
  await page.getByRole('columnheader', { name: 'Text', exact: true }).click();
  await page.keyboard.press('l');
  await expect(page.getByText('(off)', { exact: true })).toBeVisible();
  await page.keyboard.press('l');
  await expect(page.getByText('(off)', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  // A backwards transition while still playing proves the native loop actually seeks.
  let previous = -1;
  await expect.poll(async () => {
    const track = (await audio(page))[0];
    const wrapped = previous > track.currentTime + 0.1;
    previous = track.currentTime;
    return track.playing && wrapped;
  }, { timeout: 15_000, intervals: [50, 50, 100] }).toBe(true);
  await page.getByRole('button', { name: 'Pause all tracks', exact: true }).click();
  await page.getByRole('columnheader', { name: 'Text', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(start).toHaveCount(0);
  await expect(end).toHaveCount(0);
});

test('lint errors block submit until repaired, then confirmation submits the edited payload', async ({ page, babel }) => {
  await ready(page);
  const submit = page.getByRole('button', { name: 'Submit Review', exact: true });
  await editText(page, 0, '');
  await expect(row(page, 0).getByRole('button', { name: /linter errors?/ })).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(calls(await babel.state(), SUBMIT)).toHaveLength(0);
  await editText(page, 0, EDITED);
  await expect(row(page, 0).getByRole('button', { name: 'No linter issues', exact: true })).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm Submission' });
  await expect(dialog).toBeVisible();
  expect(calls(await babel.state(), SUBMIT)).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(async () => calls(await babel.state(), SUBMIT).length).toBe(1);
  await expect(page).toHaveURL(/\/projects(?:\?|$)/);
  const state = await babel.state();
  expect(state.submitted).toBe(true);
  expect(calls(state, SUBMIT)[0].body.annotations.find(annotation => annotation.id === 'row-1').content).toBe(EDITED);
  expect(state.action.annotations.find(annotation => annotation.id === 'row-1').content).toBe(EDITED);
});

test('a delayed save has a pending guard and a rejected save retains edits for a successful retry', async ({ page, babel }) => {
  await ready(page);
  await babel.control({ procedures: { [SAVE]: { delayMs: 800, times: 1 } } });
  await editText(page, 0, EDITED);
  await page.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(calls(await babel.state(), SAVE)).toHaveLength(1);
  await babel.control({ procedures: { [SAVE]: { error: { status: 500, message: 'Deliberate save rejection' }, times: 1 } } });
  const retryText = 'Привет, повторное сохранение.';
  await editText(page, 0, retryText);
  await page.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Error - Retry', exact: true })).toBeVisible();
  await expect(text(page, 0)).toHaveValue(retryText);
  expect((await babel.state()).action.annotations.find(annotation => annotation.id === 'row-1').content).toBe(EDITED);
  await page.getByRole('button', { name: 'Error - Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(calls(await babel.state(), SAVE)).toHaveLength(3);
  await page.reload();
  await ready(page);
  await expect(text(page, 0)).toHaveValue(retryText);
});

test('read-only review is a non-persisting sandbox, including after local edits and reload', async ({ page, babel }) => {
  await babel.reset('readonly', { route: `/transcription/RU-tx-gold-non-bg?reviewActionId=${ACTION}` });
  await ready(page);
  await expect(page.getByText(/No changes will persist during this read only session/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit Review', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Save progress|Saved)$/ })).toHaveCount(0);
  // The native read-only contract permits local experimentation, never persistence.
  await editText(page, 0, EDITED);
  await rowMenu(page, 1, 'Delete');
  await expect(rows(page)).toHaveCount(3);
  expect(calls(await babel.state(), SAVE)).toHaveLength(0);
  expect(calls(await babel.state(), SUBMIT)).toHaveLength(0);
  await page.reload();
  await ready(page);
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
});

test('diff comparison fetches the selected reference and renders changed text before returning to rows', async ({ page, babel }) => {
  await babel.reset('diff', { route: `/transcription/RU-tx-gold-non-bg?reviewActionId=${ACTION}` });
  await ready(page);
  await page.getByLabel('Diff View', { exact: true }).check();
  await expect.poll(async () => calls(await babel.state(), 'transcriptions.getTranscriptionDiff').length).toBeGreaterThan(0);
  await expect(page.getByText('Word Diff:', { exact: false })).toBeVisible();
  await expect(page.locator(TEXT)).toHaveCount(0);
  await expect(page.locator('tbody')).toContainText('Привет');
  await expect(page.locator('tbody')).toContainText('Удалённая тестовая фраза.');
  await page.getByLabel('Diff View', { exact: true }).uncheck();
  await ready(page);
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
});

test('native task lookup validates empty input and opens the requested action read-only', async ({ page, babel }) => {
  await babel.reset('baseline', { showTaskLookupModal: true });
  const dialog = page.getByRole('dialog', { name: 'Select Action' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Read-Only View', exact: true })).toBeDisabled();
  await dialog.getByPlaceholder('Review Action ID (For Read-Only)').fill(ACTION);
  await dialog.getByRole('button', { name: 'Read-Only View', exact: true }).click();
  await ready(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/No changes will persist during this read only session/)).toBeVisible();
  await expect(text(page, 0)).toHaveValue(ORIGINAL);
});

test('an empty queue shows the native no-work decision and returns to projects', async ({ page, babel }) => {
  await babel.reset('empty');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText("Sorry, we weren't able to find a transcription job for you!");
  await expect(page.locator(TEXT)).toHaveCount(0);
  expect(calls(await babel.state(), SAVE)).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Back to Projects', exact: true }).click();
  await expect(page).toHaveURL(/\/projects(?:\?|$)/);
});

test('warning acknowledgment gates submit and can be revoked without changing transcript text', async ({ page }) => {
  await ready(page);
  await editText(page, 0, 'Привет (это тестовая запись).');
  const warning = row(page, 0).getByRole('button', { name: /linter warning.*0 acknowledged/ });
  const submit = page.getByRole('button', { name: 'Submit Review', exact: true });
  await expect(warning).toBeVisible();
  await expect(submit).toBeDisabled();
  await warning.click();
  const acknowledged = row(page, 0).getByRole('button', { name: /linter warning.*1 acknowledged/ });
  await expect(acknowledged).toBeVisible();
  await expect(submit).toBeEnabled();
  await acknowledged.click();
  await expect(warning).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(text(page, 0)).toHaveValue('Привет (это тестовая запись).');
});

test('L2 native feedback requires each rating and comment, auto-saves, and reopens its draft', async ({ page, babel }) => {
  await babel.reset('review');
  await ready(page);
  const panel = await openFeedback(page);
  await expect(panel.getByText('Complete all fields', { exact: true })).toBeVisible();
  await expect(submitReview(page)).toBeDisabled();
  for (const [index, category] of feedbackCategoryKeys.entries()) {
    await panel.locator(`label[for="${category}-2"]`).click();
    await panel.getByPlaceholder('Provide specific feedback...').nth(index).fill(feedbackComment(index));
  }
  await panel.getByPlaceholder('Additional feedback...').fill(OTHER_FEEDBACK);
  await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
  await expect.poll(async () => (await babel.state()).feedbackDraft.inputResponses.find(response => response.formInputId === 'input-other')?.value)
    .toBe(OTHER_FEEDBACK);
  await expect(submitReview(page)).toBeEnabled();
  // The native auto-save persists exactly the shape the cold-reload journeys seed.
  expect((await babel.state()).feedbackDraft.inputResponses).toEqual(feedbackDraftResponses());
  // Reopening the actual drawer in the same client must retain the saved draft.
  await panel.getByRole('button').first().click();
  await expect(panel).not.toBeInViewport();
  await openFeedback(page);
  await expectFeedbackRestored(page, panel);
});

test('L2 native feedback restores its draft on a cold reload when the input definitions arrive first', async ({ page, babel }) => {
  const persisted = await seedFeedbackDraft(babel);
  await coldFeedbackReload(page, babel, async ({ panel, loading, deliverDraft, deliverInputs }) => {
    await deliverInputs();
    await deliverDraft();
    await expect(loading).toHaveCount(0);
    expect((await babel.state()).feedbackDraft.inputResponses).toEqual(persisted);
    await expectFeedbackRestored(page, panel);
  });
});

test('L2 native feedback discards its draft on a cold reload when the draft arrives first', async ({ page, babel }) => {
  // Captured-native defect (recovered module 73681, getOrCreateDraft onSuccess parses once with
  // `w2.current ?? N2 ?? null`): a draft resolving before the cold input definitions is discarded.
  // The restoration assertions stay unweakened so an unexpected pass flags a fixture or native change.
  // Helper's `feedbackDraftRestore` compensation is proven by
  // babel-helper-extension-repo/tests/e2e/feedback.spec.mjs (enabled restores, disabled reproduces this loss).
  test.fail(true, 'Captured-native draft-first cold-cache race; compensated by Helper feedbackDraftRestore (babel-helper-extension-repo/tests/e2e/feedback.spec.mjs)');
  const persisted = await seedFeedbackDraft(babel);
  await coldFeedbackReload(page, babel, async ({ panel, loading, deliverDraft, deliverInputs }) => {
    await deliverDraft();
    // This visible transition establishes completion of the native draft mutation callback without definitions.
    await expect(loading).toHaveCount(0);
    await expect(panel.getByPlaceholder('Provide specific feedback...')).toHaveCount(feedbackCategoryKeys.length);
    await deliverInputs();
    expect((await babel.state()).feedbackDraft.inputResponses).toEqual(persisted);
    await expectFeedbackRestored(page, panel);
  });
});

test('received feedback opens from its route and is not editable', async ({ page, babel }) => {
  await babel.reset('diff');
  const panel = page.locator('div.fixed.inset-y-0.right-0').filter({ hasText: 'Feedback Received' });
  await expect(panel).toBeInViewport();
  const comments = panel.getByPlaceholder('Provide specific feedback...');
  await expect(comments).toHaveCount(5);
  for (let index = 0; index < 5; index++) {
    await expect(comments.nth(index)).toBeDisabled();
    await expect(comments.nth(index)).toHaveValue('[E2E fixture] Проверено на синтетической записи.');
  }
  expect(calls(await babel.state(), 'transcriptionFeedbackForm.saveDraft')).toHaveLength(0);
});

test('a long transcript remains editable after scrolling and preserves the last segment on reload', async ({ page, babel }) => {
  await babel.reset('long');
  await ready(page, 40);
  const last = text(page, 39);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await editText(page, 39, 'Последняя реплика сохранена.');
  const state = await saved(page, babel);
  expect(state.action.annotations.find(annotation => annotation.id === 'row-4-9').content).toBe('Последняя реплика сохранена.');
  expect(state.action.annotations.find(annotation => annotation.id === 'row-1').content).toBe(ORIGINAL);
  await page.reload();
  await ready(page, 40);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveValue('Последняя реплика сохранена.');
});
