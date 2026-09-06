import { createHash } from 'node:crypto';

export const PLACEHOLDER_MODEL = 'e2e-placeholder-v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_TOKENS = 4096;
const KINDS = new Set(['draft', 'broker-transcribe', 'broker-redistribute', 'review', 'review-suggestions', 'local-draft', 'local-transcribe', 'local-queue']);
const marker = '[E2E placeholder]';

function assert(value, message) {
  if (!value) throw new Error(message);
}
function identifier(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}
function response(body, mode = 'placeholder', status = 200, headers = {}) {
  return { status, headers: { 'content-type': 'application/json', 'x-babel-e2e-inference': mode, ...headers }, body };
}
function summary(rows) {
  return { totalRows: rows.length, rewrittenRows: rows.filter(r => r.status === 'rewritten').length, unchangedRows: rows.filter(r => r.status === 'unchanged').length, failedRows: rows.filter(r => r.status === 'failed').length, anomalyCounts: {} };
}
function localRows(body) {
  const preserved = body.options?.preserveRows;
  if (preserved?.length) return preserved.map(row => ({ id: row.rowId, lane: row.speakerKey, startSeconds: row.startSeconds, endSeconds: row.endSeconds, text: `${marker} Проверенная тестовая запись.` }));
  assert(body.tracks?.length === 2, 'Local inference requires exactly two tracks.');
  return body.tracks.flatMap((track, lane) => [0, 1].map(index => ({ id: `e2e:${body.taskId}:${track.lane}:${index}`, lane: track.lane, startSeconds: lane * 5 + index * 3 + 0.6, endSeconds: lane * 5 + index * 2.5 + 2.4, text: `${marker} Тестовая запись ${lane + 1} ${index + 1}.` })));
}
function tokensForRows(rows) {
  return rows.flatMap(row => {
    const words = row.text.split(/\s+/);
    const step = (row.endSeconds - row.startSeconds) / words.length;
    return words.map((text, index) => ({ id: `${row.id}:${index}`, text, startSeconds: row.startSeconds + index * step, endSeconds: row.startSeconds + (index + 1) * step }));
  });
}

function placeholder(kind, body) {
  if (kind === 'draft') {
    assert(Array.isArray(body.rows), 'Draft inference requires rows.');
    const draftRows = body.rows.map(row => ({ rowId: row.rowId, rewrittenText: `${marker} ${String(row.text).trim()}`, status: 'rewritten', warnings: [PLACEHOLDER_MODEL] }));
    return { draftRows, summary: summary(draftRows), generationMeta: { model: PLACEHOLDER_MODEL, rulePackVersion: 'e2e-1', generatedAt: '2026-01-01T00:00:00.000Z' } };
  }
  if (kind === 'broker-transcribe') return { text: `${marker} Проверенная тестовая запись.`, model: PLACEHOLDER_MODEL };
  if (kind === 'broker-redistribute') {
    assert(Array.isArray(body.groups), 'Redistribution inference requires groups.');
    return { model: PLACEHOLDER_MODEL, results: body.groups.map(group => ({ groupId: group.groupId, ok: true, review: { acceptDraft: true, moves: [], notes: `${marker} Исходные слова сохранены.` }, model: PLACEHOLDER_MODEL })) };
  }
  if (kind === 'review') {
    const categories = ['Word Accuracy', 'Timestamp Accuracy', 'Punctuation & Formatting', 'Tags & Emphasis', 'Segmentation'];
    const comments = body.session?.comments;
    const feedback = categories.map(category => {
      const cardNotes = (body.session?.cards ?? []).filter(card => card.categories?.includes(category)).map(card => comments?.cardComments?.[card.id ?? String(card.changeIndex)]).filter(Boolean);
      const notes = [comments?.sessionComment, ...cardNotes].filter(Boolean);
      return { category, note: `${marker} Проверьте категорию ${category}.${notes.length ? ` Комментарии рецензента: ${notes.join(' ')}` : ''}`, score: 3 };
    });
    return { llm: { feedback, classifications: [] }, model: PLACEHOLDER_MODEL };
  }
  if (kind === 'review-suggestions') {
    const cards = body.session?.cards ?? [];
    return { suggestions: cards.map(card => {
      const cardId = card.id ?? String(card.changeIndex);
      const comment = body.session?.comments?.cardComments?.[cardId] ?? body.session?.comments?.sessionComment ?? '';
      return { proposalId: `e2e-proposal-${identifier([cardId, comment])}`, operation: 'create_template', category: card.categories?.[0] ?? 'Word Accuracy', title: `${marker} Точность расшифровки ${card.changeIndex}`, description: `${marker} Сверяйте слова с аудио.`, reportTexts: [`${marker} Проверьте расшифровку.`], reason: `${marker} Детерминированная рекомендация.${comment ? ` ${comment}` : ''}`, sourceCardIds: [cardId], decision: 'pending' };
    }) };
  }
  if (kind === 'local-draft' || kind === 'local-transcribe') {
    const rows = localRows(body);
    const models = { asr: { name: PLACEHOLDER_MODEL }, l2: { name: PLACEHOLDER_MODEL } };
    if (kind === 'local-draft') return { rows, summary: { taskId: body.taskId, trackCount: body.tracks.length, rowCount: rows.length, provider: PLACEHOLDER_MODEL }, models };
    const tracks = body.tracks.map(track => ({ lane: track.lane, tokens: tokensForRows(rows.filter(row => row.lane === track.lane)) }));
    return { taskId: body.taskId, tracks, summary: { taskId: body.taskId, trackCount: tracks.length, tokenCount: tracks.reduce((n, track) => n + track.tokens.length, 0), provider: PLACEHOLDER_MODEL }, models };
  }
  throw new Error(`Unsupported placeholder inference kind: ${kind}`);
}

function endpoint(value, label, loopbackOnly = false) {
  assert(typeof value === 'string' && value.trim(), `${label} is required.`);
  const url = new URL(value);
  assert(!url.username && !url.password && !url.search && !url.hash, `${label} must not contain credentials, query, or fragment.`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), `${label} requires HTTPS except on loopback.`);
  assert(!loopbackOnly || loopback, `${label} override is restricted to controlled loopback upstreams.`);
  return url.href.replace(/\/+$/, '');
}
async function readBounded(res, limit = MAX_OUTPUT_BYTES) {
  assert(Number(res.headers.get('content-length') ?? 0) <= limit, 'Provider response exceeds output byte limit.');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= limit, 'Provider response exceeds output byte limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
function parseChat(text, contentType) {
  let content = '';
  if (contentType.includes('text/event-stream') || /^\s*(?:data:|:)/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      assert(!event.error, 'OpenRouter returned an error event.');
      const choice = event.choices?.[0];
      assert(choice?.finish_reason !== 'length', 'OpenRouter output reached the token limit.');
      content += choice?.delta?.content ?? '';
    }
  } else {
    const json = JSON.parse(text);
    assert(!json.error, 'OpenRouter returned an error response.');
    assert(json.choices?.[0]?.finish_reason !== 'length', 'OpenRouter output reached the token limit.');
    content = json.choices?.[0]?.message?.content ?? '';
  }
  assert(typeof content === 'string' && content.trim(), 'OpenRouter returned empty assistant content.');
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
}
function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|authorization|cookie|token|secret/i.test(key)).map(([key, item]) => [key, withoutCredentials(item)]));
  return value;
}
function validateOutput(kind, body) {
  assert(body && typeof body === 'object', `${kind} model output must be an object.`);
  if (kind === 'draft') assert(Array.isArray(body.draftRows) && body.draftRows.every(row => typeof row.rowId === 'string' && typeof row.rewrittenText === 'string' && ['rewritten', 'unchanged', 'failed'].includes(row.status)) && body.summary && body.generationMeta, 'Invalid generated draft response.');
  if (kind === 'broker-transcribe') assert(typeof body.text === 'string' && body.text.trim(), 'Invalid generated transcription.');
  if (kind === 'broker-redistribute') assert(Array.isArray(body.results) && body.results.every(result => result.groupId && (result.ok ? typeof result.review?.acceptDraft === 'boolean' && Array.isArray(result.review.moves) : typeof result.error === 'string')), 'Invalid generated redistribution.');
  if (kind === 'review') assert(Array.isArray(body.llm?.feedback) && body.llm.feedback.every(item => typeof item.category === 'string' && typeof item.note === 'string'), 'Invalid generated review.');
  if (kind === 'review-suggestions') assert(Array.isArray(body.suggestions) && body.suggestions.every(item => ['create_template', 'update_template', 'disable_template'].includes(item.operation) && typeof item.reason === 'string' && Array.isArray(item.sourceCardIds)), 'Invalid generated template suggestions.');
  if (kind === 'local-draft') assert(Array.isArray(body.rows) && body.rows.length && body.rows.every(row => row.lane && row.text && row.endSeconds > row.startSeconds), 'Invalid local draft response.');
  if (kind === 'local-transcribe') assert(body.taskId && Array.isArray(body.tracks) && body.tracks.length === 2 && body.tracks.every(track => track.lane && Array.isArray(track.tokens) && track.tokens.every(token => token.text && token.endSeconds > token.startSeconds)), 'Invalid local transcription response.');
  return body;
}

/** No credential lookup or network operation occurs unless its explicit real mode is selected. */
export async function createProviderGateway(options = {}) {
  const { ai = 'placeholder', browserModels = 'placeholder', nano = 'placeholder', openrouterModel, localEngineUrl, assertBrowserModels, assertNano, environment = process.env, fetch: fetchImpl = globalThis.fetch, openrouterBaseURL, timeoutMs = 120_000, maxTokens = 2048 } = options;
  assert(['placeholder', 'openrouter', 'local'].includes(ai), `Unknown --ai mode: ${ai}`);
  assert(['placeholder', 'real'].includes(browserModels), `Unknown --browser-models mode: ${browserModels}`);
  assert(['placeholder', 'real'].includes(nano), `Unknown --nano mode: ${nano}`);
  assert(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_TOKENS, `maxTokens must be between 1 and ${MAX_TOKENS}.`);
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000, 'timeoutMs must be between 1 and 300000.');
  if (browserModels === 'real') {
    assert(typeof assertBrowserModels === 'function', '--browser-models=real requires a validated BABEL_E2E_BROWSER_MODEL_DIR preflight.');
    await assertBrowserModels();
  }
  if (nano === 'real') {
    assert(typeof assertNano === 'function', '--nano=real requires an actual LanguageModel capability preflight.');
    await assertNano();
  }
  let key;
  let base;
  const perform = async (url, init = {}) => {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return fetchImpl(url, { ...init, signal, redirect: 'error' });
  };
  if (ai === 'openrouter') {
    assert(typeof openrouterModel === 'string' && openrouterModel.trim(), '--ai=openrouter requires --openrouter-model.');
    key = environment.OPENROUTER_API_KEY;
    assert(typeof key === 'string' && key.trim(), '--ai=openrouter requires OPENROUTER_API_KEY.');
    base = openrouterBaseURL ? endpoint(openrouterBaseURL, 'openrouterBaseURL', true) : OPENROUTER;
    const catalog = await perform(`${base}/models`, { headers: { Accept: 'application/json' } });
    assert(catalog.ok, `OpenRouter model capability preflight failed (HTTP ${catalog.status}).`);
    const models = JSON.parse(await readBounded(catalog, 8 * MAX_OUTPUT_BYTES)).data;
    const model = models?.find(item => item.id === openrouterModel);
    assert(model, `OpenRouter model is not available: ${openrouterModel}`);
    assert(model.architecture?.input_modalities?.includes('audio'), 'Full E2E OpenRouter mode requires an audio-capable model for transcription.');
  }
  if (ai === 'local') {
    base = endpoint(localEngineUrl, '--local-engine-url');
    const health = await perform(`${base}/health`, { headers: { Accept: 'application/json', 'X-Babel-Local-Engine': '1' } });
    assert(health.ok, `Local engine preflight failed (HTTP ${health.status}).`);
    const status = JSON.parse(await readBounded(health));
    assert(status.ok === true && status.models && status.device, 'Local engine is not ready: provision configured ASR/punctuation models and runtime/device first.');
  }
  return {
    ai, browserModels, nano, model: ai === 'placeholder' ? PLACEHOLDER_MODEL : openrouterModel ?? 'local',
    async request({ kind, body = {}, audioTracks = [], headers = {}, signal }) {
      assert(KINDS.has(kind), `Unknown inference kind: ${kind}`);
      if (signal?.aborted) throw signal.reason ?? new Error('Inference aborted.');
      if (ai === 'placeholder') return response(placeholder(kind, body));
      if (ai === 'local') {
        assert(['local-draft', 'local-transcribe', 'local-queue'].includes(kind), `Local L0 does not support ${kind}; no text-provider fallback is permitted.`);
        const requestHeaders = new Headers({ Accept: 'application/json', 'X-Babel-Local-Engine': '1' });
        const suppliedHeaders = headers instanceof Headers ? headers : new Headers(Object.entries(headers).filter(([, value]) => value != null));
        const requestId = suppliedHeaders.get('x-babel-request-id');
        if (requestId) requestHeaders.set('X-Babel-Request-Id', requestId);
        let form;
        let path;
        if (kind === 'local-queue') {
          assert(typeof body.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId), 'Invalid local queue request ID.');
          path = `/v1/queue/${encodeURIComponent(body.requestId)}`;
        } else {
          assert(body.tracks?.length === 2 && audioTracks.length === 2, 'Real local inference requires a payload and exactly two uploaded mono WAV tracks.');
          form = new FormData();
          form.append('payload', JSON.stringify(body));
          for (const track of audioTracks) {
            assert(body.tracks.some(spec => spec.fieldName === track.fieldName), 'Uploaded audio field is absent from local track specs.');
            form.append(track.fieldName, track.blob, track.filename ?? `${track.fieldName}.wav`);
          }
          path = kind === 'local-draft' ? '/v1/draft' : '/v1/transcribe';
        }
        const upstream = await perform(`${base}${path}`, { method: form ? 'POST' : 'GET', headers: requestHeaders, body: form, signal });
        const payload = JSON.parse(await readBounded(upstream));
        if (upstream.ok && kind !== 'local-queue') validateOutput(kind, payload);
        return response(payload, ai, upstream.status, upstream.headers.has('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {});
      }
      assert(kind !== 'local-queue', 'OpenRouter has no local-engine queue API.');
      const example = placeholder(kind, body);
      const content = [{ type: 'text', text: `Perform the requested Babel ${kind} operation on the input. Return JSON only matching this response shape, using actual inferred content, never the example/test marker. Preserve all supplied identifiers and transcript words unless correcting a draft. Do not invent audio evidence. Response shape: ${JSON.stringify(example)}\nInput: ${JSON.stringify(withoutCredentials(body))}` }];
      assert(audioTracks.length <= 2, 'E2E inference accepts at most two audio tracks.');
      for (const track of audioTracks) {
        assert(track.blob?.size <= 8 * 1024 * 1024, 'Audio upload exceeds E2E per-track byte limit.');
        content.push({ type: 'input_audio', input_audio: { data: Buffer.from(await track.blob.arrayBuffer()).toString('base64'), format: 'wav' } });
      }
      const upstream = await perform(`${base}/chat/completions`, { method: 'POST', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Babel Extension E2E' }, body: JSON.stringify({ model: openrouterModel, stream: true, max_tokens: maxTokens, temperature: 0, provider: { allow_fallbacks: false }, messages: [{ role: 'system', content: 'You are a Russian transcript and review assistant. Return only the requested JSON.' }, { role: 'user', content }] }) });
      const text = await readBounded(upstream);
      assert(upstream.ok, `OpenRouter inference failed (HTTP ${upstream.status}); no retry or fallback performed.`);
      const generated = validateOutput(kind, parseChat(text, upstream.headers.get('content-type') ?? ''));
      const serialized = JSON.stringify(generated);
      assert(!serialized.includes(PLACEHOLDER_MODEL) && !serialized.includes(marker), 'Real provider returned placeholder/example content instead of inference.');
      return response(generated, ai);
    }
  };
}

/** Replace only heavyweight model execution; preserve native decode, DSP, segmentation and offscreen transport. */
export function browserInferencePlaceholderSource(source) {
  const replaceFunction = (input, start, next, replacement) => {
    const from = input.indexOf(start);
    const to = input.indexOf(next, from + start.length);
    assert(from >= 0 && to > from && input.indexOf(start, from + start.length) < 0, `Cannot locate unique browser inference seam: ${start}`);
    return input.slice(0, from) + replacement + '\n\n' + input.slice(to);
  };
  let output = replaceFunction(source, 'async function predictPunctuation(', 'function capitalizeLexicalToken(', `async function predictPunctuation(words: readonly string[]): Promise<PunctuationLabel[]> {
  await cachedArrayBuffer(PUNCTUATION_MODEL_PATH);
  return words.map((_, index) => index === words.length - 1 ? 'PERIOD' : 'O') as PunctuationLabel[];
}`);
  output = replaceFunction(output, 'async function recognizeSampleChunk(', 'function isOverlapDuplicate(', `async function recognizeSampleChunk(samples: Float32Array): Promise<SampleRecognition> {
  const fixture = await cachedArrayBuffer(ASR_MODEL_PATH);
  if (new TextDecoder().decode(new Uint8Array(fixture, 0, Math.min(64, fixture.byteLength))).startsWith('e2e-model-inference-error')) {
    throw new Error('[E2E placeholder] Controlled model inference failure.');
  }
  const durationSeconds = samples.length / SAMPLE_RATE;
  const segments = segmentSamplesByActivity(samples);
  const tokens = segments.flatMap(segment => {
    const words = ['тестовая', 'запись', 'e2e'];
    const start = segment.startSample / SAMPLE_RATE;
    const step = (segment.endSample - segment.startSample) / SAMPLE_RATE / words.length;
    return words.map((text, index) => ({ text, startSeconds: start + step * index, endSeconds: start + step * (index + 1) }));
  });
  return { durationSeconds, tokens };
}`);
  output = replaceFunction(output, 'function modelsSummary()', 'export async function generateLocalL0Timing(', `function modelsSummary(): Record<string, unknown> {
  return { asr: { name: '${PLACEHOLDER_MODEL}' }, l2: { name: '${PLACEHOLDER_MODEL}' } };
}`);
  return output;
}

/** Playwright init function: the only replaced browser API is heavyweight LanguageModel inference. */
export function browserModelInitScript() {
  const text = '[E2E placeholder] Проверенная тестовая запись.';
  class E2EPlaceholderLanguageModel {
    static e2ePlaceholder = true;
    static async availability() { return 'available'; }
    static async create() { return new E2EPlaceholderLanguageModel(); }
    destroyed = false;
    async prompt(messages, options = {}) {
      if (this.destroyed) throw new Error('LanguageModel session was destroyed.');
      if (options.signal?.aborted) throw options.signal.reason;
      if (options.responseConstraint?.properties?.acceptDraft) {
        const promptText = messages.flatMap(message => typeof message.content === 'string'
          ? [message.content]
          : (message.content ?? []).filter(part => part.type === 'text' && typeof part.value === 'string').map(part => part.value)).join('\n');
        const rows = [...promptText.matchAll(/^index=(\d+) \|[^\n]* \| draftText=("(?:[^"\\]|\\.)*")$/gm)]
          .map(match => ({ index: Number(match[1]), text: JSON.parse(match[2]) }));
        const canMove = rows.length >= 2 && rows[0].index === 1 && rows[1].index === 2
          && /\S[\s\S]*[.!?][»"')\]]*\s*$/u.test(rows[0].text);
        return JSON.stringify({
          acceptDraft: !canMove,
          moves: canMove ? [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }] : [],
          notes: '[E2E placeholder]'
        });
      }
      return JSON.stringify({ text });
    }
    promptStreaming(_messages, options = {}) {
      const destroyed = this.destroyed;
      return new ReadableStream({ start(controller) {
        if (destroyed || options.signal?.aborted) { controller.error(options.signal?.reason ?? new Error('LanguageModel session was destroyed.')); return; }
        controller.enqueue(text.slice(0, 18)); controller.enqueue(text.slice(18)); controller.close();
      } });
    }
    destroy() { this.destroyed = true; }
  }
  Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: E2EPlaceholderLanguageModel });
}
