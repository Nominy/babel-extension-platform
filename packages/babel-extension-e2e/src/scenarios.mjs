import { createHash } from 'node:crypto';

export const IDS = Object.freeze({
  project: '0bf29f0c-371a-506a-8b77-5fffd14e5762', queue: 'f95babcc-8681-521c-a39f-66454a16347f',
  action: '22222222-2222-4222-8222-222222222222', reference: '11111111-1111-4111-8111-111111111111',
  worker: '33333333-3333-4333-8333-333333333333', chunk: '44444444-4444-4444-8444-444444444444',
});
export const FIXED_TIME = '2026-09-05T00:00:00.000Z';
export const EDITOR_PATH = '/transcription/RU-tx-gold-non-bg';
export const SCENARIO_NAMES = Object.freeze(['baseline', 'readonly', 'diff', 'errors', 'empty', 'long', 'review']);
export const feedbackCategories = Object.freeze([
  ['wordAccuracy', 'Word Accuracy', 'tx-word-accuracy'], ['timestampAccuracy', 'Timestamp Accuracy', 'tx-timestamp-accuracy'],
  ['punctuationFormatting', 'Punctuation & Formatting', 'tx-punctuation-formatting'], ['tagsEmphasis', 'Tags & Emphasis', 'tx-tags-emphasis'],
  ['segmentation', 'Segmentation', 'tx-segmentation'],
]);
export const formInputs = feedbackCategories.flatMap(([key, label]) => [
  { id: `input-${key}`, label, type: 'rating', required: true },
  { id: `input-${key}-comment`, label: `${label} Comment`, type: 'textarea', required: true },
]).concat({ id: 'input-other', label: 'Other Feedback', type: 'textarea', required: false });

export function mergeScenario(target, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe scenario key: ${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) mergeScenario(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}

function annotation(id, speaker, start, end, content, actionId = IDS.action) {
  return { id, reviewActionId: actionId, type: 'transcription', content, processedRecordingId: `speaker-${speaker}`,
    speaker, speakerId: `speaker-${speaker}`, trackLabel: `Speaker ${speaker}`, startTimeInSeconds: start, endTimeInSeconds: end,
    intensity: null, metadata: { source: 'synthetic-e2e', lowConfidenceResolved: true }, createdAt: FIXED_TIME, updatedAt: FIXED_TIME };
}
function recordings(duration, baseURL) {
  return [1, 2].map((speaker) => ({ id: `recording-${speaker}`, transcriptionChunkId: IDS.chunk,
    recordingChunkId: IDS.chunk, processedRecordingId: `speaker-${speaker}`, chunkedProcessedRecordingId: `chunked-speaker-${speaker}`,
    speaker, startTimeInSeconds: 0, endTimeInSeconds: duration, processedRecordingUrl: `${baseURL}/audio/speaker-${speaker}.wav`,
    label: `Speaker ${speaker}` }));
}
function makeAction(rows, tracks) {
  return { reviewActionId: IDS.action, actionId: IDS.action, actionWorkerId: IDS.worker, actionDecision: 'in-progress', actionLevel: 1,
    isWorkerResumingClaim: false, processedTranscriptionId: IDS.chunk, transcriptionChunkId: IDS.chunk, recordingChunkId: IDS.chunk,
    transcriptionChunkProcessedRecordings: tracks, processedRecordingUriMap: Object.fromEntries(tracks.map((r) => [r.chunkedProcessedRecordingId, r.processedRecordingUrl])),
    annotations: rows, lintErrors: [], success: true };
}

export function createScenario(name = 'baseline', overrides = {}, baseURL = '') {
  if (!SCENARIO_NAMES.includes(name)) throw new Error(`Unknown E2E scenario '${name}'. Supported: ${SCENARIO_NAMES.join(', ')}`);
  const duration = name === 'long' ? 120 : 12;
  const rows = [annotation('row-1', 1, .5, 2.5, 'Привет, это тестовая запись.'),
    annotation('row-2', 1, 3.5, 5, 'Сегодня мы проверяем редактор.'),
    annotation('row-3', 2, 5.5, 7.5, 'Да, я слышу тебя хорошо.'),
    annotation('row-4', 2, 8.5, 10, 'Продолжим проверку вместе.')];
  if (name === 'long') {
    for (let cycle = 1; cycle < 10; cycle++) for (const row of rows.slice(0, 4)) rows.push({ ...structuredClone(row), id: `${row.id}-${cycle}`, startTimeInSeconds: row.startTimeInSeconds + cycle * 12, endTimeInSeconds: row.endTimeInSeconds + cycle * 12 });
  }
  const action = makeAction(rows, recordings(duration, baseURL));
  const referenceAction = structuredClone(action);
  referenceAction.actionId = referenceAction.reviewActionId = IDS.reference;
  referenceAction.actionLevel = 1;
  referenceAction.actionDecision = 'pass';
  referenceAction.annotations = referenceAction.annotations.map((row) => ({ ...row, reviewActionId: IDS.reference }));
  if (name === 'diff' || name === 'review') {
    action.actionLevel = 2;
    referenceAction.annotations[0].content = 'Привет это пробная запись';
    referenceAction.annotations[0].startTimeInSeconds = .2;
    referenceAction.annotations[0].endTimeInSeconds = 2.8;
    referenceAction.annotations[1].content = 'Сегодня мы [смех] проверяем редактор.';
    referenceAction.annotations[2].content = 'Да, я слышу тебя.';
    referenceAction.annotations[3].content = 'Удалённая тестовая фраза.';
    referenceAction.annotations[3].id = 'row-reference-only';
  }
  const readOnly = name === 'readonly' || name === 'diff';
  if (readOnly) action.actionDecision = 'pass';
  const state = {
    scenario: name, project: { projectId: IDS.project, category: 'transcription', projectName: 'RU-tx-gold-non-bg', name: 'RU-tx-gold-non-bg' },
    worker: { id: IDS.worker, name: 'Synthetic E2E Worker' },
    permissions: [{ reviewQueueId: IDS.queue, level: 2, tag: 'chunked' }, { reviewQueueId: `${IDS.queue.slice(0, -1)}8`, level: 2, tag: 'stitched' }],
    projectId: IDS.project, queueId: IDS.queue, action, referenceAction, readOnly, showTaskLookupModal: false, noWork: name === 'empty',
    audio: { laneCount: 2, duration, sampleRate: 16000, transport: 'fetch', voicedWindows: { 'speaker-1': [[.6, 2.4], [3.6, 4.9]], 'speaker-2': [[5.6, 7.4], [8.6, 9.9]] } },
    page: { path: EDITOR_PATH, search: '', showTaskLookupModal: false },
    form: { id: 'e2e-feedback-form', name: 'Synthetic review feedback', steps: [{ id: 'e2e-feedback-step', order: 0 }] },
    formInputs: structuredClone(formInputs), rubricFlagNames: feedbackCategories.map((c) => c[2]).concat('tx-other-feedback'),
    feedbackDraft: { formStepResponseId: 'e2e-feedback-response', inputResponses: [], updatedAt: FIXED_TIME },
    feedbackReceived: { inputResponses: feedbackCategories.flatMap(([key]) => [{ formInputId: `input-${key}`, value: '2' }, { formInputId: `input-${key}-comment`, value: '[E2E fixture] Проверено на синтетической записи.' }]), updatedAt: FIXED_TIME },
    controls: { procedures: {}, routes: {}, queue: { queuedMs: 150, runningMs: 300 } },
    calls: [], events: [], submitted: false, submissions: [], claimed: false, skipped: false, dropped: false, revision: 0,
    sessions: {}, draftSessions: {}, queue: {}, analytics: [],
  };
  if (name === 'errors') state.controls.procedures['transcriptions.saveAnnotationsByReviewActionId'] = { error: { status: 503, message: 'Injected E2E save failure' }, times: 1 };
  mergeScenario(state, overrides);
  if (state.readOnly) state.action.actionDecision = 'pass';
  state.page.showTaskLookupModal = state.showTaskLookupModal || state.page.showTaskLookupModal;
  state.page.search = overrides.page?.search ?? (state.noWork || state.page.showTaskLookupModal ? '' : `?reviewActionId=${state.action.actionId}${state.readOnly ? '&readOnly=true&displayFeedback=true' : ''}`);
  state.route = typeof overrides.route === 'string' ? overrides.route : state.page.path + state.page.search;
  state.pageProps = { showTaskLookupModal: state.page.showTaskLookupModal };
  return state;
}

export function makeWav(speaker, audio) {
  const frames = Math.round(audio.duration * audio.sampleRate);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(audio.sampleRate, 24); bytes.writeUInt32LE(audio.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  const windows = audio.voicedWindows[`speaker-${speaker}`] ?? [];
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / audio.sampleRate % 12;
    const window = windows.find(([start, end]) => t >= start && t < end);
    if (!window) continue;
    const envelope = Math.min(1, (t - window[0]) / .01, (window[1] - t) / .01);
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (speaker === 1 ? 220 : 330) * t) * 10000 * envelope), 44 + frame * 2);
  }
  return bytes;
}

function wordDiff(before, after) {
  const a = before.trim().split(/\s+/).filter(Boolean), b = after.trim().split(/\s+/).filter(Boolean);
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = a[i] === b[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ value: a[i++], status: 'unchanged' }); j++; }
    else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) out.push({ value: a[i++], status: 'removed' });
    else out.push({ value: b[j++], status: 'added' });
  }
  return out;
}
function segment(row) { return { annotationId: row.id, text: row.content, content: row.content, startTime: row.startTimeInSeconds, endTime: row.endTimeInSeconds, startTimeInSeconds: row.startTimeInSeconds, endTimeInSeconds: row.endTimeInSeconds, wordRange: [0, row.content.trim().split(/\s+/).length] }; }
export function transcriptionDiff(reference, current) {
  const timestampDetails = [];
  const speakerDiffs = [1, 2].map((speaker) => {
    const before = reference.annotations.filter((r) => r.processedRecordingId === `speaker-${speaker}`);
    const after = current.annotations.filter((r) => r.processedRecordingId === `speaker-${speaker}`);
    const ids = new Set([...before.map((r) => r.id), ...after.map((r) => r.id)]);
    const segmentMappings = [...ids].map((id) => {
      const a = before.find((r) => r.id === id), b = after.find((r) => r.id === id);
      const referenceText = a?.content ?? '', hypothesisText = b?.content ?? '';
      const wordDiffs = wordDiff(referenceText, hypothesisText);
      const removed = wordDiffs.filter((word) => word.status === 'removed').length;
      const added = wordDiffs.filter((word) => word.status === 'added').length;
      const substitutions = Math.min(removed, added);
      if (a && b) {
        const startShiftMs = (b.startTimeInSeconds - a.startTimeInSeconds) * 1000;
        const endShiftMs = (b.endTimeInSeconds - a.endTimeInSeconds) * 1000;
        timestampDetails.push({ refText: referenceText, hypText: hypothesisText, refStart: a.startTimeInSeconds, refEnd: a.endTimeInSeconds,
          hypStart: b.startTimeInSeconds, hypEnd: b.endTimeInSeconds, startShiftMs, endShiftMs,
          avgShiftMs: (Math.abs(startShiftMs) + Math.abs(endShiftMs)) / 2, quality: Math.abs(startShiftMs) + Math.abs(endShiftMs) < 100 ? 'high' : 'low' });
      }
      return { relationship: a && b ? (referenceText === hypothesisText ? 'unchanged' : 'modified') : a ? 'deleted' : 'added',
        referenceText, hypothesisText, segmentsA: a ? [segment(a)] : [], segmentsB: b ? [segment(b)] : [], wordDiffs,
        substitutions, insertions: added - substitutions, deletions: removed - substitutions };
    });
    return { speaker, processedRecordingId: `speaker-${speaker}`, segmentMappings, wordDiffs: wordDiff(before.map((r) => r.content).join(' '), after.map((r) => r.content).join(' ')) };
  });
  const mappings = speakerDiffs.flatMap((speaker) => speaker.segmentMappings);
  const totalWords = reference.annotations.reduce((count, row) => count + row.content.trim().split(/\s+/).length, 0);
  const substitutions = mappings.reduce((n, m) => n + m.substitutions, 0), insertions = mappings.reduce((n, m) => n + m.insertions, 0), deletions = mappings.reduce((n, m) => n + m.deletions, 0);
  return { referenceReviewActionId: reference.actionId, currentReviewActionId: current.actionId, referenceLevel: reference.actionLevel, currentLevel: current.actionLevel,
    speakerDiffs, referenceAnnotations: reference.annotations, currentAnnotations: current.annotations,
    wer: (substitutions + insertions + deletions) / Math.max(1, totalWords), substitutions, insertions, deletions, totalWords,
    timestampMetrics: { segments: { details: timestampDetails } } };
}

export function browserModelFixture(inferenceError = false) {
  const paths = ['asr/v3_ctc.onnx', 'asr/v3_ctc.yaml', 'punctuation/model.int8.onnx', 'punctuation/config.json', 'punctuation/tokenizer.json', 'punctuation/tokenizer_config.json', 'punctuation/special_tokens_map.json', 'punctuation/vocab.txt'];
  const files = new Map(paths.map((path) => [path, Buffer.from(path.endsWith('.json') ? '{"e2eFixture":true,"notAnInferenceModel":true}' : `E2E transport fixture only; not an inference model: ${path}\n`)]));
  if (inferenceError) files.set('asr/v3_ctc.onnx', Buffer.from('e2e-model-inference-error: explicit deterministic heavyweight boundary failure'));
  const records = [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
  return { files, manifest: { schema: 'babel-browser-model-bundle-v1', targetBytes: 500000000, pass: true, e2eFixture: true, notAnInferenceModel: true, ...(inferenceError ? { negativeFixture: 'invalid-inference-model' } : {}), totalBytes: records.reduce((n, f) => n + f.bytes, 0), files: records } };
}
