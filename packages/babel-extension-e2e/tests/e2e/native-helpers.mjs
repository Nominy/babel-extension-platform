import { expect } from '../../src/test.mjs';
import { feedbackCategories } from '../../src/scenarios.mjs';

export const TEXT = 'textarea[placeholder="What was said…"]';
export const SAVE = 'transcriptions.saveAnnotationsByReviewActionId';
export const SUBMIT = 'transcriptions.submitTranscriptReviewAction';
export const rows = page => page.locator('tbody tr').filter({ has: page.locator(TEXT) });
export const row = (page, index) => rows(page).nth(index);
export const text = (page, index) => row(page, index).locator(TEXT);
export const waveformRegion = (page, id) => page.locator(`[part~="region"][part~="${id}"]`);
export const FEEDBACK_INPUTS = 'forms.getFormInputsByStepId';
export const FEEDBACK_DRAFT = 'transcriptionFeedbackForm.getOrCreateDraft';
export const feedbackCategoryKeys = feedbackCategories.map(([key]) => key);
export const feedbackComment = index => `Проверена категория ${index + 1}.`;
export const OTHER_FEEDBACK = 'Все изменения проверены вручную.';
export const feedbackPanel = page => page.locator('div.fixed.inset-y-0.right-0').filter({ hasText: 'L1 Feedback Form' });
export const submitReview = page => page.getByRole('button', { name: 'Submit Review', exact: true });

export async function ready(page, count = 4) {
  let rejectRuntime;
  const runtimeFailed = new Promise((_, reject) => { rejectRuntime = reject; });
  const onPageError = error => rejectRuntime(new Error(`Recovered editor failed during readiness:\n${error.stack ?? error.message}`));
  page.on('pageerror', onPageError);
  // The real error boundary also retains failures that happened before this helper began.
  const boundary = page.locator('main.recovered-error[role="alert"]');
  const boundaryFailed = boundary.waitFor({ state: 'visible', timeout: 30_000 })
    .then(async () => { throw new Error(`Recovered editor runtime failure:\n${await boundary.innerText()}`); });
  try {
    await Promise.race([
      runtimeFailed,
      boundaryFailed,
      (async () => {
        await expect(page.locator(TEXT)).toHaveCount(count);
        await expect(page.getByRole('button', { name: 'Play all tracks', exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
          const snapshot = window.__BABEL_E2E__?.snapshot();
          return Boolean(snapshot?.ready && snapshot.audio.ready);
        }), { message: 'Native table and decoded WaveSurfer tracks must both be ready' }).toBe(true);
        await expect(page.getByText(/Loading Tracks\.\.\./)).toHaveCount(0);
        await expect(rows(page)).toHaveCount(count);
        await expect(text(page, 0)).toBeVisible();
      })(),
    ]);
  } finally {
    page.off('pageerror', onPageError);
  }
}

export async function editText(page, index, content) {
  await text(page, index).fill(content);
  // Enter is the native textarea commit gesture: it blurs and flushes its debounce.
  await text(page, index).press('Enter');
  await expect(text(page, index)).not.toBeFocused();
  await expect(text(page, index)).toHaveValue(content);
}

export async function history(page, operation) {
  await page.getByRole('columnheader', { name: 'Text', exact: true }).click();
  await page.keyboard.press(operation === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z');
}

export async function rowMenu(page, index, name) {
  await row(page, index).locator('td').last().getByRole('button').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function saved(page, babel) {
  await page.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  return babel.state();
}

export function calls(state, procedure) {
  return state.calls.filter(call => call.procedure === procedure);
}

export async function audio(page) {
  // The harness reads the genuine recovered WaveSurfer getters; it exposes no commands.
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks);
}

export async function audioReady(page) {
  await expect.poll(async () => (await audio(page)).map(track => ({ id: track.id, duration: Math.round(track.duration) })))
    .toEqual([{ id: 'speaker-1', duration: 12 }, { id: 'speaker-2', duration: 12 }]);
}

export async function persistedAnnotations(babel) {
  return (await babel.state()).action.annotations;
}

export async function regionTimes(page, id) {
  const tracks = await audio(page);
  return tracks.flatMap(track => track.regions.map(region => ({ ...region, trackId: track.id }))).find(region => region.id === id);
}

export async function dragAcross(page, locator, start, end) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width * start, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
}

export async function holdProcedureResponse(page, babel, procedure) {
  let releaseResponse;
  let responseReceived;
  let responseFailed;
  const released = new Promise(resolve => { releaseResponse = resolve; });
  const received = new Promise((resolve, reject) => {
    responseReceived = resolve;
    responseFailed = reject;
  });
  const match = url => url.pathname === `/api/trpc/${procedure}`;
  const handler = async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      delete headers.host;
      delete headers['content-length'];
      // Node transport reaches the real scenario server without the browser's CONNECT proxy.
      const response = await fetch(new URL(url.pathname + url.search, babel.apiURL), {
        method: request.method(), headers, body: request.postDataBuffer() ?? undefined,
      });
      const body = Buffer.from(await response.arrayBuffer());
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      responseReceived();
      await released;
      await route.fulfill({ status: response.status, headers: responseHeaders, body });
    } catch (error) {
      responseFailed(error);
      await route.abort('failed');
    }
  };
  await page.route(match, handler);
  return {
    received,
    release: releaseResponse,
    // Releases the held response and returns once the browser has actually received it.
    async deliver() {
      const delivered = page.waitForResponse(response => match(new URL(response.url())));
      releaseResponse();
      await delivered;
    },
    async dispose() {
      releaseResponse();
      await page.unroute(match, handler);
    },
  };
}

// The complete L2 draft exactly as the native form persists it (the warm native journey proves the shape).
export const feedbackDraftResponses = () => feedbackCategoryKeys.flatMap((key, index) => [
  { formInputId: `input-${key}`, value: '2' },
  { formInputId: `input-${key}-comment`, value: feedbackComment(index) },
]).concat({ formInputId: 'input-other', value: OTHER_FEEDBACK });

export async function seedFeedbackDraft(babel) {
  const inputResponses = feedbackDraftResponses();
  await babel.reset('review', { feedbackDraft: { inputResponses } });
  return inputResponses;
}

export async function openFeedback(page) {
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  const panel = feedbackPanel(page);
  await expect(panel).toBeInViewport();
  return panel;
}

export async function expectFeedbackRestored(page, panel) {
  for (const [index, category] of feedbackCategoryKeys.entries()) {
    await expect(panel.locator(`#${category}-2`)).toBeChecked();
    await expect(panel.getByPlaceholder('Provide specific feedback...').nth(index)).toHaveValue(feedbackComment(index));
  }
  await expect(panel.getByPlaceholder('Additional feedback...')).toHaveValue(OTHER_FEEDBACK);
  await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
  await expect(submitReview(page)).toBeEnabled();
}

export async function expectFeedbackDiscarded(page, panel) {
  await expect(panel.getByPlaceholder('Provide specific feedback...')).toHaveCount(feedbackCategoryKeys.length);
  for (const [index, category] of feedbackCategoryKeys.entries()) {
    await expect(panel.locator(`#${category}-2`)).not.toBeChecked();
    await expect(panel.getByPlaceholder('Provide specific feedback...').nth(index)).toHaveValue('');
  }
  await expect(panel.getByPlaceholder('Additional feedback...')).toHaveValue('');
  await expect(panel.getByText('Complete all fields', { exact: true })).toBeVisible();
  await expect(submitReview(page)).toBeDisabled();
}

// Cold-loads the real draft and input-definition responses under test-controlled completion order,
// without replacing any payload. `run` decides the order through `deliverDraft`/`deliverInputs`.
export async function coldFeedbackReload(page, babel, run) {
  const inputs = await holdProcedureResponse(page, babel, FEEDBACK_INPUTS);
  const draft = await holdProcedureResponse(page, babel, FEEDBACK_DRAFT);
  try {
    await page.reload();
    await Promise.all([inputs.received, draft.received]);
    await ready(page);
    const panel = await openFeedback(page);
    const loading = panel.getByText('Loading draft...', { exact: true });
    await expect(loading).toBeVisible();
    await run({ panel, loading, deliverDraft: () => draft.deliver(), deliverInputs: () => inputs.deliver() });
  } finally {
    await Promise.all([inputs.dispose(), draft.dispose()]);
  }
}
