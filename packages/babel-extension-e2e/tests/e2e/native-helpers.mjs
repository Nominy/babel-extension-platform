import { expect } from '../../src/test.mjs';
import { feedbackCategories } from '../../src/scenarios.mjs';

export const TEXT = '[role="textbox"][aria-label="Edit turn text"], [contenteditable="true"][data-slate-editor="true"]';
export const ROW = 'section[data-annotation-id]';
export const SAVE = 'transcriptions.saveAnnotationsByReviewActionId';
export const SUBMIT = 'transcriptions.submitTranscriptReviewAction';
export const rows = page => page.locator(ROW);
export const row = (page, index) => rows(page).nth(index);
export const text = (page, index) => row(page, index).locator(TEXT);

// Read raw tag spelling from the actual rendered native components, not a guessed
// delimiter. Slate tag elements carry `raw`; static chips expose source offsets.
function inspectTurnText(element, { operation, start, end }) {
  const propsAbove = function* (node) {
    const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
    for (let fiber = key && node[key]; fiber; fiber = fiber.return) {
      if (fiber.memoizedProps) yield fiber.memoizedProps;
    }
  };
  const rawChip = node => {
    for (const props of propsAbove(node)) {
      if (props.element?.type === 'tag' && typeof props.element.raw === 'string') return props.element.raw;
      if (node.hasAttribute('data-chip') && typeof props.text === 'string') {
        const offset = Number(node.dataset.offset);
        return props.text.slice(offset, offset + Number(node.dataset.chip));
      }
    }
    throw new Error('Native tag chip has no recoverable raw spelling');
  };
  const pieces = [];
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const zeroWidth = node.parentElement.closest('[data-slate-zero-width]');
      pieces.push({ node, text: zeroWidth ? '' : node.textContent, chip: false });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches('[data-chip], [data-slate-void="true"]')) {
        pieces.push({ node, text: rawChip(node), chip: true });
      } else if (!node.matches('button')) {
        node.childNodes.forEach(visit);
      }
    }
  };
  visit(element);
  if (operation === 'read') return pieces.map(piece => piece.text).join('');
  if (operation === 'select') {
    const point = offset => {
      for (const piece of pieces) {
        if (!piece.chip && offset <= piece.text.length) return [piece.node, Math.max(offset, 0)];
        offset -= piece.text.length;
      }
      if (offset === 0 && pieces.length === 0) return [element, 0];
      throw new Error('Selection offset exceeds turn text');
    };
    const [anchor, anchorOffset] = point(start);
    const [focus, focusOffset] = point(end);
    window.getSelection().setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    document.dispatchEvent(new Event('selectionchange'));
    return;
  }
  const selection = window.getSelection();
  if (!selection || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null;
  const offset = (node, index) => {
    const endpoint = document.createRange();
    endpoint.setStart(node, index);
    endpoint.collapse(true);
    let result = 0;
    for (const piece of pieces) {
      if (piece.node === node) return result + Math.min(index, piece.text.length);
      if (piece.chip && piece.node.contains(node)) return result + piece.text.length;
      if (endpoint.comparePoint(piece.node, 0) >= 0) return result;
      result += piece.text.length;
    }
    return result;
  };
  const anchor = offset(selection.anchorNode, selection.anchorOffset);
  const focus = offset(selection.focusNode, selection.focusOffset);
  return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

export async function readText(editor) {
  return editor.evaluate(inspectTurnText, { operation: 'read' });
}

export async function readTexts(page) {
  return page.locator(TEXT).evaluateAll(elements => elements.map(element => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[data-slate-zero-width], [contenteditable="false"] button').forEach(node => node.remove());
    return clone.textContent;
  }));
}

export async function readRawTexts(page) {
  return rows(page).evaluateAll(elements => {
    const annotations = new Map(window.__BABEL_E2E__.snapshot().annotations.map(annotation => [annotation.id, annotation.content]));
    return elements.map(element => {
      const id = element.dataset.annotationId;
      if (!annotations.has(id)) throw new Error(`Missing native annotation for turn ${id}`);
      return annotations.get(id);
    });
  });
}

export const speaker = (page, index) => row(page, index).getByLabel('Speaker', { exact: true });
export const startTime = (page, index) => row(page, index).getByRole('button', { name: /^\d+:\d{2}\.\d{2}$/ }).nth(0);
export const endTime = (page, index) => row(page, index).getByRole('button', { name: /^\d+:\d{2}\.\d{2}$/ }).nth(1);
export const transcriptScroll = page => page.locator('[data-transcript-scroll]');

export async function focusTranscript(page) {
  await transcriptScroll(page).click({ position: { x: 2, y: 2 } });
}

export async function rowValues(page) {
  const values = await rows(page).evaluateAll(elements => elements.map(element => {
    const times = [...element.querySelectorAll('button')].map(button => button.textContent).filter(value => /^\d+:\d{2}\.\d{2}$/.test(value));
    return {
      speaker: element.querySelector('select').selectedOptions[0].textContent,
      start: times[0],
      end: times[1],
    };
  }));
  return Promise.all(values.map(async (value, index) => ({
    ...value,
    text: await readText(row(page, index).locator('[aria-label="Edit turn text"], [data-slate-editor="true"], :scope > div > div[dir].whitespace-pre-wrap')),
  })));
}

export async function selectText(editor, start, end = start) {
  await editor.click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.evaluate(inspectTurnText, { operation: 'select', start, end });
}

export async function textSelection(editor) {
  return editor.evaluate(inspectTurnText, { operation: 'selection' });
}
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
        await expect(rows(page)).toHaveCount(count);
        await expect(page.getByRole('button', { name: 'Play all tracks', exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
          const snapshot = window.__BABEL_E2E__?.snapshot();
          return Boolean(snapshot?.ready && snapshot.audio.ready);
        }), { message: 'Native turns and decoded WaveSurfer tracks must both be ready' }).toBe(true);
        await expect(page.getByText(/Loading Tracks\.\.\./)).toHaveCount(0);
        await expect(rows(page)).toHaveCount(count);
        await expect(row(page, 0)).toBeVisible();
      })(),
    ]);
  } finally {
    page.off('pageerror', onPageError);
  }
}

export async function fillText(editor, content) {
  // Native focus mounts Slate. Its selection is model-owned: use the real
  // select-all gesture rather than Playwright.fill's DOM-only selection.
  await editor.focus();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.press('ControlOrMeta+A');
  if (content.length) await editor.page().keyboard.insertText(content);
  else await editor.press('Backspace');
}

export async function editText(page, index, content) {
  await fillText(text(page, index), content);
  // Enter commits the native edit and moves focus out of the text control.
  await text(page, index).press('Enter');
  await expect(text(page, index)).not.toBeFocused();
}

export async function history(page, operation) {
  await focusTranscript(page);
  await page.keyboard.press(operation === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z');
}

export async function rowMenu(page, index, name) {
  const trigger = row(page, index).locator('button[aria-haspopup="menu"]');
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function saved(page, babel) {
  const save = page.getByRole('button', { name: 'Save', exact: true });
  if (await save.isVisible()) await save.click();
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

export async function listenThrough(page) {
  await audioReady(page);
  // Focusing a turn can seek to its start. Use the native gap control so the
  // initial unheard fraction is played too, rather than starting at that caret.
  const unheard = page.getByRole('button', { name: 'Not listened yet, click to play from here', exact: true });
  if (await unheard.count()) await unheard.first().click();
  else {
    const complete = await page.evaluate(() => {
      const coverage = window.__BABEL_E2E__.snapshot().listening;
      return coverage.duration > 0 && coverage.timelineGapCount === 0 && coverage.speakers.every(speaker => speaker.gapCount === 0);
    });
    if (!complete) await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => {
    const coverage = window.__BABEL_E2E__.snapshot().listening;
    return coverage.duration > 0 && coverage.timelineGapCount === 0
      && coverage.speakers.every(speaker => speaker.gapCount === 0);
  }), {
    timeout: 20_000,
    message: 'Genuine playback must cover the timeline and each unmuted speaker',
  }).toBe(true);
  await expect.poll(async () => (await audio(page)).every(track => !track.playing)).toBe(true);
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
  await ready(page);
  // Native listening coverage persists across reload; finish it before isolating
  // feedback response ordering so the separate submit gate cannot mask restoration.
  await listenThrough(page);
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
