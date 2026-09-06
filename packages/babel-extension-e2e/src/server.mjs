import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createProviderGateway } from './providers.mjs';
import { createScenario, mergeScenario, makeWav, transcriptionDiff, browserModelFixture, feedbackCategories, FIXED_TIME, IDS } from './scenarios.mjs';
import { loadSpeechFixtures } from '../fixture-data/speech-fixtures.mjs';

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const secretKey = /authorization|cookie|api.?key|access.?token|refresh.?token|password|secret|credential/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : sanitize(item)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/sk-or-v1-[\w-]+/g, '[REDACTED]');
  return value;
}
function requireObject(body) { if (!object(body)) throw new HttpError(400, 'Expected a JSON object'); }
function requireString(value, label) { if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} must be a non-empty string`); return value; }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function parseRequest(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD') return { body: undefined, audioTracks: [], files: [] };
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 32 * 1024 * 1024) throw new HttpError(413, 'E2E request exceeds 32 MiB'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) return { body: {}, audioTracks: [], files: [] };
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    let form;
    try { form = await new Request(url, { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
    catch { throw new HttpError(400, 'Invalid multipart form'); }
    let body;
    try { body = JSON.parse(requireString(form.get('payload'), 'multipart payload')); }
    catch (error) { throw new HttpError(400, `Invalid multipart payload: ${error.message}`); }
    const audioTracks = [...form.entries()].filter(([, value]) => typeof value !== 'string').map(([fieldName, blob]) => {
      const metadataField = fieldName.startsWith('audioTrack:') ? `audioTrackMeta:${fieldName.slice('audioTrack:'.length)}` : null;
      let metadata = {};
      if (metadataField && form.has(metadataField)) {
        try { metadata = JSON.parse(form.get(metadataField)); requireObject(metadata); }
        catch { throw new HttpError(400, `Invalid ${metadataField}`); }
      }
      return { fieldName, blob, filename: blob.name, metadata };
    });
    return { body, audioTracks, files: audioTracks.map(({ fieldName, blob, filename, metadata }) => ({ fieldName, name: filename, size: blob.size, type: blob.type, ...sanitize(metadata) })) };
  }
  try { return { body: JSON.parse(bytes.toString('utf8')), audioTracks: [], files: [] }; }
  catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}

const templateData = feedbackCategories.map(([key, label], index) => ({ id: `e2e-${key}`, title: `${label} correction`, description: `Synthetic fixture: review ${label.toLowerCase()}.`, category: label, reportTexts: [`[E2E fixture] Correct ${label.toLowerCase()}.`], score: 1, index }));
function reviewCards(original, current) {
  const previous = new Map(original.annotations.map((row) => [row.id, row]));
  const currentIds = new Set(current.annotations.map((row) => row.id));
  const cards = [];
  function add(before, after, type, category) {
    cards.push({ id: `card-${cards.length + 1}`, changeIndex: cards.length + 1, type, description: `${type}: ${before} → ${after}`, summary: `${type} change`, evidence: `${before} → ${after}`, evidenceDetail: { kind: 'text-diff', before, after }, categories: [category], matchedTemplateId: null, templateTitle: null, templateDescription: null, initialMatchedTemplateId: null, initialTemplateTitle: null, initialTemplateDescription: null, matchSource: 'unmatched', opinionText: '', rationale: '' });
  }
  for (const row of current.annotations) {
    const before = previous.get(row.id);
    if (!before) add('', row.content, 'ADDED', 'Segmentation');
    else {
      if (before.content !== row.content) add(before.content, row.content, 'TEXT', 'Word Accuracy');
      if (before.startTimeInSeconds !== row.startTimeInSeconds || before.endTimeInSeconds !== row.endTimeInSeconds) add(`${before.startTimeInSeconds}–${before.endTimeInSeconds}`, `${row.startTimeInSeconds}–${row.endTimeInSeconds}`, 'TIMESTAMP', 'Timestamp Accuracy');
    }
  }
  for (const row of original.annotations) if (!currentIds.has(row.id)) add(row.content, '', 'REMOVED', 'Segmentation');
  return cards;
}
function reviewRequest(body) {
  requireObject(body); requireString(body.reviewActionId, 'reviewActionId');
  for (const key of ['original', 'current']) if (!object(body[key]) || !Array.isArray(body[key].annotations)) throw new HttpError(400, `${key}.annotations must be an array`);
}
function validateAnnotations(rows) {
  if (!Array.isArray(rows)) throw new HttpError(400, 'annotations must be an array');
  const ids = new Set();
  for (const row of rows) {
    requireObject(row); requireString(row.id, 'annotation.id');
    if (ids.has(row.id)) throw new HttpError(400, `Duplicate annotation id: ${row.id}`);
    ids.add(row.id);
    if (typeof row.content !== 'string') throw new HttpError(400, 'annotation.content must be a string');
    if (row.type === 'transcription' && (!Number.isFinite(row.startTimeInSeconds) || !Number.isFinite(row.endTimeInSeconds) || row.startTimeInSeconds < 0 || row.endTimeInSeconds <= row.startTimeInSeconds)) throw new HttpError(400, `Invalid annotation time range: ${row.id}`);
  }
}

export async function startScenarioServer(options = {}) {
  const { port = 0, ai = 'placeholder', browserModels = 'placeholder', browserModelDir = process.env.BABEL_E2E_BROWSER_MODEL_DIR } = options;
  const gateway = await createProviderGateway({ ...options, ai, browserModels, browserModelDir });
  const speech = await loadSpeechFixtures(options.speechFixtures);
  let modelRoot;
  if (browserModels === 'real') {
    if (!browserModelDir) throw new Error('--browser-models=real requires BABEL_E2E_BROWSER_MODEL_DIR');
    modelRoot = await realpath(resolve(browserModelDir));
  }
  let state, generation = 0, sequence = 0, baseURL;
  const fixtureModels = browserModelFixture();
  const errorModels = browserModelFixture(true);
  const audioCache = new Map();
  const inFlight = new Set();
  const heldRequests = new Map();
  function buildScenario(name, overrides = {}) {
    const next = createScenario(name, overrides, baseURL);
    if (next.audio.fixture === 'speech') {
      if (!speech) throw new HttpError(400, "audio.fixture='speech' requires --speech-fixtures=DIR");
      const normalize = (rows, actionId) => rows.map((row) => ({ ...row, reviewActionId: actionId, type: 'transcription', intensity: null, metadata: { source: 'explicit-local-speech-fixture', lowConfidenceResolved: true }, createdAt: FIXED_TIME, updatedAt: FIXED_TIME }));
      next.audio = { ...next.audio, duration: speech.duration, sampleRate: speech.sampleRate, source: 'explicit-local-speech-fixture' };
      if (!overrides.action?.annotations) next.action.annotations = normalize(speech.annotations, next.action.actionId);
      if (!overrides.referenceAction?.annotations) next.referenceAction.annotations = normalize(speech.referenceAnnotations ?? speech.annotations, next.referenceAction.actionId);
      for (const action of [next.action, next.referenceAction]) for (const track of action.transcriptionChunkProcessedRecordings) track.endTimeInSeconds = speech.duration;
    }
    return next;
  }
  function reset(name, overrides) { const next = buildScenario(name, overrides); generation++; state = next; audioCache.clear(); return state; }
  function event(type, data = {}) { state.events.push({ id: ++sequence, type, ...sanitize(data) }); }
  function record(req, path, body, files, procedure) {
    const call = { id: ++sequence, method: req.method, path, ...(procedure ? { procedure } : {}), body: sanitize(body), files: files ?? [], outcome: 'pending' };
    state.calls.push(call); return call;
  }
  function takeControl(group, key) {
    const controls = state.controls[group] ?? {};
    const setting = controls[key];
    if (!setting) return {};
    const value = clone(setting);
    if (setting.times !== undefined) {
      if (!Number.isInteger(setting.times) || setting.times < 1) return {};
      if (--setting.times === 0) delete controls[key];
    }
    return value;
  }
  async function applyControl(control, expectedGeneration) {
    if (control.delayMs) await sleep(Math.min(Math.max(0, control.delayMs), 120000));
    if (generation !== expectedGeneration) throw new HttpError(409, 'Stale task: scenario was reset during this request', 'CONFLICT');
    if (control.error) throw new HttpError(control.error.status ?? 500, typeof control.error === 'string' ? control.error : control.error.message ?? 'Injected E2E error', control.error.code);
  }
  function actionById(id) {
    if (id === state.action.actionId) return state.action;
    if (id === state.referenceAction.actionId) return state.referenceAction;
    throw new HttpError(404, `Review action not found: ${id}`, 'NOT_FOUND');
  }
  function editable(body) {
    requireObject(body);
    const action = actionById(body.reviewActionId ?? body.actionId ?? state.action.actionId);
    if (action !== state.action) throw new HttpError(403, 'Reference actions cannot be edited', 'FORBIDDEN');
    if (state.readOnly || action.actionWorkerId !== state.worker.id || action.actionDecision !== 'in-progress') throw new HttpError(403, 'Review action is not editable by this worker', 'FORBIDDEN');
    return action;
  }
  function persistAnnotations(body) {
    const action = editable(body); validateAnnotations(body.annotations);
    action.annotations = clone(body.annotations); action.lintErrors = []; state.revision++;
    event('annotations-saved', { reviewActionId: action.actionId, revision: state.revision });
    return { success: true, revision: state.revision };
  }
  function reviewActions() { return [state.referenceAction, state.action].map((a) => ({ id: a.actionId, reviewActionId: a.actionId, level: a.actionLevel, actionLevel: a.actionLevel, workerId: a.actionWorkerId, createdAt: FIXED_TIME, decision: a.actionDecision })); }
  function procedure(name, body) {
    switch (name) {
      case 'transcriptions.getWorkerPermissionsForProject': return state.permissions;
      case 'transcriptions.checkActiveClaimForQueue': return state.claimed ? { reviewActionId: state.action.actionId, queueId: state.queueId } : null;
      case 'transcriptions.getReviewActionDataById': return actionById(body?.reviewActionId);
      case 'transcriptions.getLatestReviewActionByProcessedTranscriptionId':
        if (body?.processedTranscriptionId !== state.action.processedTranscriptionId) throw new HttpError(404, 'Processed transcription not found');
        return state.action;
      case 'transcriptions.claimNextReviewActionFromReviewQueue':
      case 'transcriptions.claimReviewActionByProcessedTranscriptionId': {
        if (state.noWork || state.submitted || state.skipped || state.dropped) return { success: false, error: 'No tasks available', annotations: [], transcriptionChunkProcessedRecordings: [], processedRecordingUriMap: {} };
        if (body?.processedTranscriptionId && body.processedTranscriptionId !== state.action.processedTranscriptionId) throw new HttpError(404, 'Processed transcription not found');
        if (state.action.actionWorkerId !== state.worker.id) return { belongsToAnotherWorker: true, success: false };
        state.claimed = true; event('claimed', { reviewActionId: state.action.actionId }); return { ...state.action, belongsToAnotherWorker: false };
      }
      case 'transcriptions.getAnnotationsByReviewActionId': { const a = actionById(body?.reviewActionId); return { annotations: a.annotations, lintErrors: a.lintErrors }; }
      case 'transcriptions.saveAnnotationsByReviewActionId': return persistAnnotations(body);
      case 'transcriptions.submitTranscriptReviewAction': {
        if (body?.original && body?.current && body?.inputBoxes) { state.analytics.push(sanitize(body)); event('review-analytics'); return { success: true }; }
        persistAnnotations(body); state.submitted = true; state.action.actionDecision = 'pass'; state.submissions.push(clone(body)); event('submitted', { reviewActionId: state.action.actionId }); return { success: true, linterErrors: [] };
      }
      case 'transcriptions.dropWorkerAction': editable(body); state.dropped = true; state.claimed = false; state.action.actionWorkerId = null; state.action.actionDecision = 'not-started'; event('dropped'); return { success: true };
      case 'transcriptions.skipTranscriptReviewAction': editable(body); state.skipped = true; state.action.actionDecision = 'archived'; event('skipped'); return { success: true };
      case 'transcriptions.adminRateTtsTranscription': editable(body); state.action.rating = body.rating; state.action.ratingReason = body.ratingReason; state.action.actionDecision = 'fail'; event('rated', body); return { success: true };
      case 'transcriptions.emitReviewActionEvents':
        if (!Array.isArray(body)) throw new HttpError(400, 'Review events must be an array');
        for (const item of body) { actionById(item.reviewActionId); event('native-review-event', item); } return { success: true };
      case 'transcriptions.getReviewActionsForChunk': return reviewActions().filter((a) => a.id !== body?.reviewActionId);
      case 'annotations.getReviewActionsForRecordingChunk': return reviewActions().filter((a) => a.id !== body?.excludeReviewActionId);
      case 'transcriptions.getTranscriptionDiff': return transcriptionDiff(actionById(body?.referenceReviewActionId), actionById(body?.currentReviewActionId));
      case 'annotations.getAnnotationDiffOverlay': return { referenceAnnotations: actionById(body?.referenceReviewActionId).annotations, currentAnnotations: actionById(body?.currentReviewActionId).annotations };
      case 'annotations.getAnnotationMetricsDiff': return { metrics: { referenceCount: actionById(body?.referenceReviewActionId).annotations.length, currentCount: actionById(body?.currentReviewActionId).annotations.length } };
      case 'audits.getPresignedUrls':
      case 'application.getAudioPresignedUrls': {
        if (!Array.isArray(body?.s3Urls)) throw new HttpError(400, 's3Urls must be an array');
        const allowed = new Map([state.action, state.referenceAction].flatMap((a) => a.transcriptionChunkProcessedRecordings.map((r) => [a.processedRecordingUriMap[r.chunkedProcessedRecordingId], r.processedRecordingUrl])));
        return Object.fromEntries(body.s3Urls.map((url) => { if (!allowed.has(url)) throw new HttpError(404, `No presigned audio fixture for ${url}`); return [url, allowed.get(url)]; }));
      }
      case 'transcriptionFeedbackForm.getRubricFlagNames': return state.rubricFlagNames;
      case 'transcriptionFeedbackForm.getForm': return state.form;
      case 'forms.getFormInputsByStepId': if (body?.stepId !== state.form.steps[0].id) throw new HttpError(404, 'Form step not found'); return state.formInputs;
      case 'transcriptionFeedbackForm.getOrCreateDraft': editable(body); return state.feedbackDraft;
      case 'transcriptionFeedbackForm.saveDraft': {
        editable({ reviewActionId: state.action.actionId });
        if (body?.formStepResponseId !== state.feedbackDraft.formStepResponseId) throw new HttpError(404, 'Feedback draft not found');
        if (!Array.isArray(body.inputResponses) || body.inputResponses.some((r) => !state.formInputs.some((input) => input.id === r.formInputId) || typeof r.value !== 'string')) throw new HttpError(400, 'Invalid feedback inputResponses');
        state.feedbackDraft.inputResponses = clone(body.inputResponses); state.feedbackDraft.updatedAt = FIXED_TIME; event('feedback-saved'); return state.feedbackDraft;
      }
      case 'transcriptionFeedbackForm.getFeedbackReceived': actionById(body?.reviewActionId); return state.feedbackReceived;
      case 'worker.getProjects': case 'worker.getProjectsWithAvailability': return [{ ...state.project, availableTasks: state.noWork || state.submitted ? 0 : 1 }];
      case 'worker.getProjectById': return state.project;
      case 'transcriptions.getChunkConsensus': return state.consensus ?? null;
      case 'transcriptions.isDegradedTranscriptionChunk': return state.degraded ?? false;
      case 'transcriptions.getAssessmentInfo': return state.assessment ?? null;
      case 'transcriptions.getAssessmentAttemptCount': return { attemptCount: state.assessmentAttempts?.length ?? 0 };
      case 'transcriptions.getOnboardingAttemptStatus': return state.onboarding ?? null;
      case 'transcriptions.submitPracticeAttempt':
      case 'transcriptions.submitAssessment': {
        if (!state.assessment) throw new HttpError(409, 'This scenario is not an assessment task');
        persistAnnotations(body); (state.assessmentAttempts ??= []).push(clone(body));
        const diff = transcriptionDiff(state.referenceAction, state.action);
        const words = diff.speakerDiffs.flatMap((s) => s.wordDiffs); const changed = words.filter((w) => w.status !== 'unchanged').length;
        const wordErrorRate = changed / Math.max(1, words.filter((w) => w.status !== 'added').length);
        return { success: true, passed: wordErrorRate <= (state.assessment.maxWer ?? .1), granted: false, wordErrorRate, attemptNumber: state.assessmentAttempts.length };
      }
      case 'transcriptions.getStitchedChunkReviewers': return state.reviewers ?? [];
      case 'transcriptions.getTtsScriptContext': return state.ttsScriptContext ?? null;
      case 'transcriptions.getTtsOriginalScript': return state.ttsOriginalScript ?? null;
      case 'transcriptions.getTtsTranscriptionWords': return state.ttsTranscriptionWords ?? null;
      case 'transcriptions.getForeignTagDictionary': return state.foreignTagDictionary ?? { buildId: 'e2e-foreign-v1', language: 'RU', defaultVerdict: 'low', autoTag: [], entries: [] };
      case 'tts.getTagNamesByType': return state.ttsTagNames ?? [];
      case 'backgroundNoise.getNoiseEventsForRecordings': return state.noiseEvents ?? [];
      default: throw new HttpError(404, `Unknown E2E tRPC procedure: ${name}`, 'NOT_FOUND');
    }
  }
  async function trpc(req, res, url, parsed) {
    const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
    const batch = url.searchParams.get('batch') === '1' || names.length > 1;
    let raw = parsed.body;
    if (req.method === 'GET') { try { raw = JSON.parse(url.searchParams.get('input') ?? '{}'); } catch { throw new HttpError(400, 'Invalid tRPC input JSON'); } }
    if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'tRPC supports GET and POST');
    const expectedGeneration = generation;
    const results = await Promise.all(names.map(async (name, index) => {
      const envelope = batch ? raw?.[index] : raw;
      const body = object(envelope) && own(envelope, 'json') ? envelope.json : envelope;
      const call = record(req, `/api/trpc/${name}`, body, parsed.files, name);
      try {
        const control = takeControl('procedures', name); await applyControl(control, expectedGeneration);
        const data = own(control, 'response') ? control.response : procedure(name, body);
        call.outcome = 'success'; call.response = sanitize(data);
        return { status: 200, value: { result: { data: { json: data } } } };
      } catch (error) {
        const status = error.status ?? 500, code = error.code ?? ({ 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' }[status] ?? 'INTERNAL_SERVER_ERROR');
        call.outcome = 'error'; call.error = { status, message: sanitize(error.message) };
        return { status, value: { error: { json: { message: sanitize(error.message), code: status === 404 ? -32004 : status === 400 ? -32600 : -32603, data: { code, httpStatus: status, path: name } } } } };
      }
    }));
    const statuses = new Set(results.map((r) => r.status));
    json(res, statuses.size === 1 ? results[0].status : 207, batch ? results.map((r) => r.value) : results[0].value);
  }
  async function generated(kind, body, parsed, req) {
    const controller = new AbortController(); inFlight.add(controller);
    const expectedGeneration = generation;
    try {
      const response = await gateway.request({ kind, body, audioTracks: parsed.audioTracks, headers: { 'X-Babel-Request-Id': req.headers['x-babel-request-id'] }, signal: controller.signal });
      if (expectedGeneration !== generation) throw new HttpError(409, 'Stale task: scenario was reset during inference');
      if (response.status < 200 || response.status >= 300) {
        const error = new HttpError(response.status, typeof response.body === 'string' ? response.body : response.body?.error ?? response.body?.detail ?? 'Provider request failed');
        error.headers = response.headers;
        throw error;
      }
      return response.body;
    } finally { inFlight.delete(controller); }
  }
  function sessionById(id) { const session = state.sessions[id]; if (!session) throw new HttpError(404, `Review session not found: ${id}`); return session; }
  function mutableSession(id) { const session = sessionById(id); if (session.finalized) throw new HttpError(409, 'Review session is already finalized'); return session; }
  async function reviewRoute(path, method, body, parsed, req) {
    if (path === '/api/review/generate' && method === 'POST') { reviewRequest(body); return generated('review', body, parsed, req); }
    if (path === '/api/review/sessions' && method === 'POST') {
      reviewRequest(body);
      const cards = reviewCards(body.original, body.current);
      const output = await generated('review', { ...body, cards }, parsed, req);
      const sessionId = `e2e-session-${Object.keys(state.sessions).length + 1}`;
      const session = { sessionId, reviewActionId: body.reviewActionId, original: clone(body.original), current: clone(body.current), babelDiff: clone(body.babelDiff ?? null), prepared: { reviewActionId: body.reviewActionId }, cards, categoryFeedback: output.llm?.feedback ?? [], comments: { sessionComment: '', cardComments: {} }, suggestions: [], aiReview: output.llm ?? null, finalized: false, backendVersion: { service: 'babel-e2e-scenario', release: 'synthetic', apiSchema: 1, evidenceSchema: 1 } };
      for (const classification of output.llm?.classifications ?? []) {
        const card = cards.find((c) => c.changeIndex === classification.change), template = templateData.find((t) => t.id === classification.templateId);
        if (card && template) Object.assign(card, { matchedTemplateId: template.id, templateTitle: template.title, templateDescription: template.description, initialMatchedTemplateId: template.id, initialTemplateTitle: template.title, initialTemplateDescription: template.description, matchSource: 'model' });
      }
      state.sessions[sessionId] = session; event('review-session-created', { sessionId }); return session;
    }
    const match = /^\/api\/review\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) throw new HttpError(404, `Unknown E2E review endpoint: ${method} ${path}`);
    const id = decodeURIComponent(match[1]), operation = match[2];
    if (method === 'GET' && !operation) return sessionById(id);
    if (method !== 'POST') throw new HttpError(405, 'Review session mutations require POST');
    requireObject(body); const session = mutableSession(id);
    if (operation === 'comments') {
      if (typeof body.sessionComment !== 'string' || !object(body.cardComments) || Object.values(body.cardComments).some((v) => typeof v !== 'string')) throw new HttpError(400, 'Invalid review session comments');
      const ids = new Set(session.cards.map((c) => c.id));
      if (Object.keys(body.cardComments).some((cardId) => !ids.has(cardId))) throw new HttpError(400, 'Comment references an unknown card');
      session.comments = clone(body); event('review-comments-saved', { sessionId: id }); return session;
    }
    const cardMatch = /^cards\/([^/]+)\/(template-match|template-clear)$/.exec(operation ?? '');
    if (cardMatch) {
      const card = session.cards.find((c) => c.id === decodeURIComponent(cardMatch[1]));
      if (!card) throw new HttpError(404, 'Review card not found');
      const template = cardMatch[2] === 'template-match' ? templateData.find((t) => t.id === body.templateId) : null;
      if (cardMatch[2] === 'template-match' && !template) throw new HttpError(404, 'Review template not found');
      Object.assign(card, { matchedTemplateId: template?.id ?? null, templateTitle: template?.title ?? null, templateDescription: template?.description ?? null, matchSource: template ? 'manual' : 'manual_cleared' });
      event('review-template-changed', { sessionId: id, cardId: card.id, templateId: template?.id ?? null }); return session;
    }
    if (operation === 'template-suggestions') {
      const output = await generated('review-suggestions', { session }, parsed, req);
      if (!Array.isArray(output.suggestions)) throw new HttpError(502, 'Provider returned invalid template suggestions');
      session.suggestions = output.suggestions; event('review-suggestions-generated', { sessionId: id }); return session;
    }
    const decisionMatch = /^template-suggestions\/([^/]+)\/decision$/.exec(operation ?? '');
    if (decisionMatch) {
      if (!['approved', 'rejected'].includes(body.decision)) throw new HttpError(400, 'Template decision must be approved or rejected');
      const proposal = session.suggestions.find((p) => p.proposalId === decodeURIComponent(decisionMatch[1]));
      if (!proposal) throw new HttpError(404, 'Template suggestion not found');
      if (proposal.decision && proposal.decision !== 'pending') throw new HttpError(409, 'Template suggestion has already been decided');
      proposal.decision = body.decision;
      if (body.decision === 'approved') {
        for (const card of session.cards) {
          if (!proposal.sourceCardIds.includes(card.id) && !(proposal.targetTemplateId && proposal.targetTemplateId === card.matchedTemplateId)) continue;
          const disabled = proposal.operation === 'disable_template';
          Object.assign(card, { categories: [proposal.category], matchedTemplateId: disabled ? null : `proposal:${proposal.proposalId}`, templateTitle: disabled ? null : proposal.title, templateDescription: disabled ? null : proposal.description, matchSource: disabled ? 'manual_cleared' : 'manual', opinionText: disabled ? '' : (proposal.reportTexts ?? []).join(' ') });
        }
        (state.pendingTemplateProposals ??= []).push({ queueId: proposal.proposalId, approvedAt: FIXED_TIME, sessionId: id, reviewActionId: session.reviewActionId, proposal: clone(proposal) });
      }
      event('review-suggestion-decided', { sessionId: id, proposalId: proposal.proposalId, decision: body.decision }); return session;
    }
    if (operation === 'finalize') {
      if (body.mode !== undefined && !['skip', 'apply'].includes(body.mode)) throw new HttpError(400, 'Finalize mode must be skip or apply');
      const output = await generated('review', { reviewActionId: session.reviewActionId, original: session.original, current: session.current, session }, parsed, req);
      session.categoryFeedback = output.llm?.feedback ?? []; session.aiReview = output.llm ?? null; session.finalized = true; session.finalizeMode = body.mode ?? 'apply';
      event('review-session-finalized', { sessionId: id, mode: session.finalizeMode }); return session;
    }
    throw new HttpError(404, `Unknown E2E review session operation: ${operation}`);
  }
  async function route(req, res, url, parsed, control) {
    const path = url.pathname, method = req.method, body = parsed.body;
    if (path === '/health' && method === 'GET') return { status: 'ok', service: 'babel-e2e-scenario', ai, browserModels };
    if (path === '/api/review/templates/search' && method === 'GET') {
      const query = url.searchParams.get('q') ?? '', limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
      const needle = query.trim().toLowerCase();
      return { query, results: templateData.filter((t) => !needle || `${t.title} ${t.description} ${t.category}`.toLowerCase().includes(needle)).slice(0, limit) };
    }
    if (path.startsWith('/api/review/')) return reviewRoute(path, method, body, parsed, req);
    if (['/api/draft/generate', '/api/draft/generate/stream'].includes(path) && method === 'POST') {
      requireObject(body); requireString(body.jobId, 'jobId');
      if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, 'Draft rows must be a non-empty array');
      const key = body.draftSessionId || body.jobId;
      let result = path.endsWith('/stream') ? null : state.draftSessions[key]?.result;
      if (!result) {
        result = await generated('draft', body, parsed, req);
        state.draftSessions[key] = { jobId: body.jobId, body: sanitize(body), result };
      }
      if (!path.endsWith('/stream')) return result;
      const events = [['started', { jobId: body.jobId, totalRows: body.rows.length }]];
      result.draftRows.forEach((row, index) => events.push(['row', { row, completedRows: index + 1, totalRows: body.rows.length, summary: result.summary }]));
      events.push(control.streamError ? ['error', { error: control.streamError }] : ['done', result]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const expectedGeneration = generation;
      let count = 0;
      for (const [name, data] of events) {
        if (control.truncateAfterEvents !== undefined && count >= control.truncateAfterEvents) break;
        if (control.eventDelayMs) await sleep(Math.min(control.eventDelayMs, 30000));
        if (res.destroyed || generation !== expectedGeneration) break;
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); count++;
      }
      res.end(); return result;
    }
    if (path === '/api/broker/transcribe-segment' && method === 'POST') {
      requireObject(body); requireObject(body.segment);
      if (!Number.isFinite(body.segment.startSeconds) || !Number.isFinite(body.segment.endSeconds) || body.segment.endSeconds <= body.segment.startSeconds) throw new HttpError(400, 'Invalid broker segment time range');
      if (!parsed.audioTracks.length) throw new HttpError(400, 'Segment transcription requires audio');
      return generated('broker-transcribe', body, parsed, req);
    }
    if (path === '/api/broker/redistribute-text' && method === 'POST') {
      requireObject(body); if (!Array.isArray(body.groups) || !body.groups.length) throw new HttpError(400, 'Redistribution groups must be a non-empty array');
      return generated('broker-redistribute', body, parsed, req);
    }
    if (['/v1/draft', '/v1/transcribe', '/api/local-engine/draft'].includes(path) && method === 'POST') {
      requireObject(body); requireString(body.taskId, 'taskId');
      if (req.headers['x-babel-local-engine'] !== '1') throw new HttpError(400, 'X-Babel-Local-Engine: 1 is required');
      if (!Array.isArray(body.tracks) || body.tracks.length !== 2 || parsed.audioTracks.length !== 2) throw new HttpError(400, 'L0 requires exactly two WAV tracks');
      for (const track of body.tracks) {
        const audio = parsed.audioTracks.find((a) => a.fieldName === track.fieldName);
        if (!audio) throw new HttpError(400, `Missing audio field ${track.fieldName}`);
        const header = Buffer.from(await audio.blob.slice(0, 44).arrayBuffer());
        if (header.length < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' || header.readUInt16LE(22) !== 1) throw new HttpError(400, `L0 track ${track.fieldName} must be mono WAV`);
      }
      const requestId = req.headers['x-babel-request-id'] ?? `e2e-l0-${++sequence}`;
      const expectedGeneration = generation;
      state.queue[requestId] = { requestId, status: 'queued', position: 1, queuedCount: 1, taskId: body.taskId };
      if (ai === 'placeholder') {
        await sleep(control.queuedMs ?? state.controls.queue.queuedMs ?? 150);
        if (generation !== expectedGeneration) throw new HttpError(409, 'Stale L0 task after reset');
        Object.assign(state.queue[requestId], { status: 'running', position: 0, queuedCount: 0 });
        await sleep(control.runningMs ?? state.controls.queue.runningMs ?? 300);
        if (generation !== expectedGeneration) throw new HttpError(409, 'Stale L0 task after reset');
      }
      try {
        const output = await generated(path.endsWith('/transcribe') ? 'local-transcribe' : 'local-draft', body, parsed, req);
        Object.assign(state.queue[requestId], { status: 'completed', position: 0, queuedCount: 0 }); return output;
      } catch (error) { if (generation === expectedGeneration) Object.assign(state.queue[requestId], { status: 'error', error: sanitize(error.message) }); throw error; }
    }
    const queueMatch = /^\/v1\/queue\/([^/]+)$/.exec(path);
    if (queueMatch && method === 'GET') {
      const requestId = decodeURIComponent(queueMatch[1]);
      if (ai === 'local') return generated('local-queue', { requestId }, parsed, req);
      if (!state.queue[requestId]) throw new HttpError(404, 'L0 request not admitted yet'); return state.queue[requestId];
    }
    const audioMatch = /^\/(?:audio|babel-fixture)\/speaker[-_]([12])\.wav$/.exec(path);
    if ((audioMatch || browserModels !== 'real' && path === '/browser-model/sample-russian-15s.wav') && ['GET', 'HEAD'].includes(method)) {
      const speaker = Number(audioMatch?.[1] ?? 1);
      if (speaker > state.audio.laneCount) throw new HttpError(404, 'Audio lane absent in this scenario');
      if (!audioCache.has(speaker)) audioCache.set(speaker, state.audio.fixture === 'speech' ? speech.tracks.get(speaker) : makeWav(speaker, state.audio));
      const bytes = audioCache.get(speaker); let start = 0, end = bytes.length - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range) throw new HttpError(416, 'Unsupported audio byte range');
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end) { res.setHeader('Content-Range', `bytes */${bytes.length}`); throw new HttpError(416, 'Audio byte range outside file'); }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      }
      res.writeHead(status, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      res.end(method === 'HEAD' ? undefined : bytes.subarray(start, end + 1)); return { syntheticAudio: true, speaker, bytes: end - start + 1 };
    }
    if (path.startsWith('/browser-model/') && ['GET', 'HEAD'].includes(method)) {
      const relative = decodeURIComponent(path.slice('/browser-model/'.length));
      if (!relative || relative.split(/[\\/]/).some((p) => !p || p === '.' || p === '..')) throw new HttpError(400, 'Invalid model fixture path');
      const negativeFixture = state.controls.models?.inferenceError === true && relative !== 'sample-russian-15s.wav';
      let bytes;
      if (browserModels === 'real' && !negativeFixture) {
        let file;
        try { file = await realpath(resolve(modelRoot, relative)); } catch { throw new HttpError(404, 'Local model file not found'); }
        if (!file.startsWith(modelRoot + sep)) throw new HttpError(403, 'Model path leaves configured directory');
        const info = await stat(file);
        if (!info.isFile()) throw new HttpError(404, 'Local model file not found');
        if (control.corrupt) res.setHeader('X-Babel-E2E-Negative-Fixture', 'model-byte-corruption');
        res.writeHead(200, { 'Content-Type': relative.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': info.size });
        if (method === 'HEAD') res.end();
        else if (control.corrupt) {
          let changed = false;
          const corruptFirstByte = new Transform({
            transform(chunk, encoding, callback) {
              if (!changed && chunk.length) { chunk[0] ^= 255; changed = true; }
              callback(null, chunk);
            },
          });
          await pipeline(createReadStream(file), corruptFirstByte, res);
        } else await pipeline(createReadStream(file), res);
        return { modelFile: relative, bytes: info.size, transportFixture: false, corrupted: control.corrupt === true };
      } else {
        const models = negativeFixture ? errorModels : fixtureModels;
        if (negativeFixture) res.setHeader('X-Babel-E2E-Negative-Fixture', 'invalid-inference-model');
        if (relative === 'manifest.json') return models.manifest;
        bytes = models.files.get(relative);
        if (!bytes) throw new HttpError(404, `Unknown model fixture file: ${relative}`);
      }
      if (control.corrupt) { bytes = Buffer.from(bytes); bytes[0] ^= 255; }
      res.writeHead(200, { 'Content-Type': relative.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': bytes.length }); res.end(method === 'HEAD' ? undefined : bytes); return { modelFile: relative, bytes: bytes.length, transportFixture: true, negativeFixture: negativeFixture ? 'invalid-inference-model' : null, corrupted: control.corrupt === true };
    }
    throw new HttpError(404, `Unknown E2E endpoint: ${method} ${path}`);
  }
  const server = createServer(async (req, res) => {
    const requestTarget = req.url;
    if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/') || requestTarget.startsWith('//') || requestTarget.includes('\\')) {
      json(res, 400, { error: 'E2E API requires an origin-form request target without authority or backslashes' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { json(res, 403, { error: 'Only loopback and extension origins may access the E2E API' }); return; }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Babel-Local-Engine, X-Babel-Request-Id, X-TRPC-Source');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Babel-Request-Id');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let call;
    try {
      const url = new URL(requestTarget, baseURL), parsed = await parseRequest(req, url);
      if (url.pathname === '/__e2e__/state' && req.method === 'GET') { json(res, 200, sanitize(state)); return; }
      if (url.pathname === '/__e2e__/reset' && req.method === 'POST') {
        requireObject(parsed.body); reset(parsed.body.scenario ?? 'baseline', parsed.body.overrides ?? {});
        json(res, 200, sanitize(state)); return;
      }
      if (url.pathname === '/__e2e__/control' && req.method === 'POST') {
        requireObject(parsed.body);
        for (const key of Object.keys(parsed.body)) if (!['procedures', 'routes', 'queue', 'models', 'release'].includes(key)) throw new HttpError(400, `Unknown control group: ${key}`);
        for (const value of Object.values(parsed.body)) requireObject(value);
        const releases = Object.entries(parsed.body.release ?? {});
        for (const [hold, value] of releases) if (value !== true || !heldRequests.has(hold)) throw new HttpError(400, `No pending request hold to release: ${hold}`);
        for (const [key, value] of Object.entries(parsed.body)) if (key !== 'release') state.controls[key] = clone(value);
        for (const [hold] of releases) {
          const waiters = heldRequests.get(hold); heldRequests.delete(hold);
          for (const release of waiters) release();
          event('request-released', { hold });
        }
        json(res, 200, sanitize(state)); return;
      }
      if (url.pathname === '/__e2e__/events' && req.method === 'POST') { requireObject(parsed.body); event(requireString(parsed.body.type, 'event.type'), parsed.body); json(res, 200, { success: true }); return; }
      if (url.pathname.startsWith('/api/trpc/')) { await trpc(req, res, url, parsed); return; }
      call = record(req, url.pathname, parsed.body, parsed.files);
      const control = takeControl('routes', url.pathname); await applyControl(control, generation);
      const hold = control.holdResponse === undefined ? undefined : requireString(control.holdResponse, 'control.holdResponse');
      if (hold !== undefined && !['/v1/draft', '/v1/transcribe', '/api/local-engine/draft'].includes(url.pathname)) throw new HttpError(400, 'Response holds require an L0 JSON inference endpoint');
      if (control.disconnect === true) {
        call.outcome = 'network-error';
        call.error = { code: 'E2E_DISCONNECT', message: 'Injected connection close before response headers' };
        req.socket.destroy();
        return;
      }
      const output = own(control, 'response') ? control.response : await route(req, res, url, parsed, control);
      if (output === undefined) throw new HttpError(500, `E2E route produced no response: ${url.pathname}`);
      call.response = sanitize(output);
      if (hold !== undefined) {
        call.outcome = 'held';
        await new Promise((resolve) => {
          if (!heldRequests.has(hold)) heldRequests.set(hold, new Set());
          heldRequests.get(hold).add(resolve);
          event('response-held', { hold, path: url.pathname, requestId: req.headers['x-babel-request-id'] });
        });
      }
      call.outcome = 'success';
      if (!res.headersSent) json(res, 200, output);
    } catch (error) {
      const status = error.status ?? 500, message = sanitize(error.message ?? 'E2E server error');
      if (call) { call.outcome = 'error'; call.error = { status, message }; }
      if (!res.headersSent && error.headers) for (const [key, value] of Object.entries(error.headers)) if (['retry-after', 'x-babel-request-id', 'x-babel-e2e-inference'].includes(key.toLowerCase())) res.setHeader(key, value);
      if (!res.headersSent) json(res, status, { error: message }); else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  baseURL = `http://127.0.0.1:${server.address().port}`; reset('baseline', {});
  return { url: baseURL, async close() {
    generation++;
    for (const waiters of heldRequests.values()) for (const release of waiters) release();
    heldRequests.clear();
    for (const controller of inFlight) controller.abort();
    await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await gateway.close?.();
  } };
}
