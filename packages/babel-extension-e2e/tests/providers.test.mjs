import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { text as responseText } from 'node:stream/consumers';
import { startNetworkFence } from '../src/runner.mjs';
import { createProviderGateway, PLACEHOLDER_MODEL, browserModelInitScript } from '../src/providers.mjs';

async function upstream(t, handle) {
  const calls = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      calls.push({ path: req.url, headers: req.headers, body });
      await handle(req, res, body);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
const json = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const catalog = { data: [{ id: 'controlled/audio-model', architecture: { input_modalities: ['text', 'audio'] } }] };
const realOptions = url => ({ ai: 'openrouter', openrouterModel: 'controlled/audio-model', environment: { OPENROUTER_API_KEY: 'not-a-secret-controlled-test-key' }, openrouterBaseURL: url });
const payload = { taskId: 'task', tracks: [{ lane: 'speaker-1', fieldName: 'audio0' }, { lane: 'speaker-2', fieldName: 'audio1' }] };
const audioTracks = payload.tracks.map(track => ({ fieldName: track.fieldName, filename: `${track.fieldName}.wav`, blob: new Blob([Buffer.from('RIFFtestWAVE')], { type: 'audio/wav' }) }));

test('default inference never reads credentials or accesses network and produces marked deterministic task responses', async () => {
  const gateway = await createProviderGateway({ environment: new Proxy({}, { get() { throw new Error('credential lookup forbidden'); } }), fetch() { throw new Error('network forbidden'); } });
  const request = { kind: 'draft', body: { rows: [{ rowId: 'row1', text: 'Тест.' }] } };
  const first = await gateway.request(request);
  assert.deepEqual(first, await gateway.request(request));
  assert.equal(first.body.generationMeta.model, PLACEHOLDER_MODEL);
  assert.equal(first.body.draftRows[0].rowId, 'row1');
  assert.match(first.body.draftRows[0].rewrittenText, /E2E placeholder/);
  const timing = (await gateway.request({ kind: 'local-transcribe', body: payload })).body;
  assert.deepEqual(timing.tracks.map(track => track.lane), ['speaker-1', 'speaker-2']);
  assert.ok(timing.tracks.every(track => track.tokens.every(token => token.endSeconds > token.startSeconds)));
  await assert.rejects(gateway.request({ kind: 'unknown' }), /Unknown inference kind/);
});

test('real modes reject missing prerequisites without inference or implicit environment opt-in', async () => {
  const denied = () => { throw new Error('network forbidden'); };
  await assert.rejects(createProviderGateway({ ai: 'openrouter', fetch: denied }), /openrouter-model/);
  await assert.rejects(createProviderGateway({ ai: 'openrouter', openrouterModel: 'model', environment: {}, fetch: denied }), /OPENROUTER_API_KEY/);
  await assert.rejects(createProviderGateway({ ai: 'local', fetch: denied }), /local-engine-url/);
  await assert.rejects(createProviderGateway({ browserModels: 'real', fetch: denied }), /BABEL_E2E_BROWSER_MODEL_DIR/);
  await assert.rejects(createProviderGateway({ nano: 'real', fetch: denied }), /LanguageModel/);
  await assert.rejects(createProviderGateway({ browserModels: 'real', assertBrowserModels() { throw new Error('invalid model hashes'); }, fetch: denied }), /invalid model hashes/);
  await assert.rejects(createProviderGateway({ ...realOptions('https://example.com'), fetch: denied }), /loopback/);
  await assert.rejects(createProviderGateway({ ai: 'local', localEngineUrl: 'http://example.com', fetch: denied }), /HTTPS/);
});

test('OpenRouter explicit mode uses actual bounded SSE chat transport and parses fragmented events', async t => {
  const local = await upstream(t, (req, res) => {
    if (req.url === '/models') return json(res, catalog);
    assert.equal(req.url, '/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = JSON.stringify({ text: 'Реальная контролируемая расшифровка.', model: 'controlled/audio-model' });
    res.write(`: provider heartbeat\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 14) } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(14) }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const gateway = await createProviderGateway(realOptions(local.url));
  const result = await gateway.request({ kind: 'broker-transcribe', body: { segment: { rowId: 'row1' }, openRouterApiKey: 'must-not-leak-into-prompt' }, audioTracks });
  assert.equal(result.body.text, 'Реальная контролируемая расшифровка.');
  assert.equal(result.headers['x-babel-e2e-inference'], 'openrouter');
  const call = local.calls.find(call => call.path === '/chat/completions');
  const request = JSON.parse(call.body);
  assert.equal(call.headers.authorization, 'Bearer not-a-secret-controlled-test-key');
  assert.equal(request.model, 'controlled/audio-model');
  assert.equal(request.stream, true);
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.provider.allow_fallbacks, false);
  assert.equal(request.messages[1].content[1].input_audio.format, 'wav');
  assert.ok(!call.body.includes('must-not-leak-into-prompt'));
  assert.equal(local.calls.filter(call => call.path === '/chat/completions').length, 1);
});

test('OpenRouter errors, empty content and token truncation never retry or fall back', async t => {
  let responseKind = 'http';
  const local = await upstream(t, (req, res) => {
    if (req.url === '/models') return json(res, catalog);
    if (responseKind === 'http') return json(res, { error: 'rate limited' }, 429);
    if (responseKind === 'empty') return json(res, { choices: [{ message: { content: '' } }] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{' }, finish_reason: 'length' }] })}\n\n`);
  });
  const gateway = await createProviderGateway(realOptions(local.url));
  await assert.rejects(gateway.request({ kind: 'broker-transcribe' }), /HTTP 429/);
  responseKind = 'empty';
  await assert.rejects(gateway.request({ kind: 'broker-transcribe' }), /empty assistant/);
  responseKind = 'truncated';
  await assert.rejects(gateway.request({ kind: 'broker-transcribe' }), /token limit/);
  assert.equal(local.calls.filter(call => call.path === '/chat/completions').length, 3);
});

test('OpenRouter model capability preflight fails before any completion request', async t => {
  const local = await upstream(t, (_req, res) => json(res, { data: [{ id: 'controlled/audio-model', architecture: { input_modalities: ['text'] } }] }));
  await assert.rejects(createProviderGateway(realOptions(local.url)), /audio-capable/);
  assert.deepEqual(local.calls.map(call => call.path), ['/models']);
});

test('local real mode uploads only transcription audio and drafts from cached timing', async t => {
  const local = await upstream(t, async (req, res, bytes) => {
    if (req.url === '/health') return json(res, { ok: true, device: 'cpu', models: { asr: 'controlled', l2: 'controlled' } });
    if (req.url === '/v1/queue/request-1') return json(res, { requestId: 'request-1', status: 'queued', position: 1, queuedCount: 1 });
    assert.equal(req.headers['x-babel-local-engine'], '1');
    assert.equal(req.headers['x-babel-request-id'], 'request-1');
    if (req.url === '/v1/transcribe') {
      const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      assert.deepEqual(JSON.parse(form.get('payload')), payload);
      assert.equal(form.get('audio0').name, 'audio0.wav');
      assert.equal(form.get('audio1').name, 'audio1.wav');
    } else {
      assert.equal(req.url, '/v1/draft');
      assert.deepEqual(JSON.parse(bytes.toString()), { timing: { taskId: 'task', tracks: [{ lane: 'speaker-1' }, { lane: 'speaker-2' }] } });
    }
    return json(res, { detail: 'too many in-flight requests' }, 429, { 'retry-after': '5' });
  });
  const gateway = await createProviderGateway({ ai: 'local', localEngineUrl: local.url, environment: new Proxy({}, { get() { throw new Error('credentials forbidden'); } }) });
  const headers = { 'X-Babel-Request-Id': 'request-1', Authorization: 'must-not-forward' };
  await gateway.request({ kind: 'local-transcribe', body: payload, audioTracks, headers });
  const result = await gateway.request({ kind: 'local-draft', body: { timing: { taskId: 'task', tracks: [{ lane: 'speaker-1' }, { lane: 'speaker-2' }] } }, headers });
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '5');
  assert.equal(result.body.detail, 'too many in-flight requests');
  assert.equal(local.calls[1].headers.authorization, undefined);
  assert.equal(local.calls[2].headers.authorization, undefined);
  const queue = await gateway.request({ kind: 'local-queue', body: { requestId: 'request-1' } });
  assert.equal(queue.body.status, 'queued');
  await assert.rejects(gateway.request({ kind: 'review' }), /does not support review/);
  assert.deepEqual(local.calls.map(call => call.path), ['/health', '/v1/transcribe', '/v1/draft', '/v1/queue/request-1']);
});

test('unready local health aborts startup and HTTP redirects cannot bypass endpoint restriction', async t => {
  let redirect = false;
  const local = await upstream(t, (_req, res) => {
    if (redirect) { res.writeHead(302, { location: 'https://example.com/health' }); res.end(); return; }
    json(res, { ok: false, device: 'cuda', models: {} });
  });
  await assert.rejects(createProviderGateway({ ai: 'local', localEngineUrl: local.url }), /not ready/);
  redirect = true;
  await assert.rejects(createProviderGateway({ ai: 'local', localEngineUrl: local.url }));
  assert.equal(local.calls.length, 2);
});

test('Nano placeholder is explicitly marked and obeys session destruction and streamed text contracts', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'LanguageModel');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'LanguageModel', original); else delete globalThis.LanguageModel; });
  browserModelInitScript();
  assert.equal(LanguageModel.e2ePlaceholder, true);
  const session = await LanguageModel.create();
  const review = JSON.parse(await session.prompt([], { responseConstraint: { properties: { acceptDraft: {} } } }));
  assert.deepEqual(review.moves, []);
  const options = { responseConstraint: { properties: { acceptDraft: {} } } };
  const firstRow = 'index=1 | id=row1 | start=0.600 | end=2.400 | draftText="Первое предложение. Второе предложение."';
  const secondRow = 'index=2 | id=row2 | start=3.600 | end=4.900 | draftText="Третье предложение."';
  const messages = rows => [{ role: 'user', content: [{ type: 'text', value: `Draft rows:\n${rows.join('\n')}\n\nAudio samples follow.` }] }];
  const moveReview = JSON.parse(await session.prompt(messages([firstRow, secondRow]), options));
  assert.equal(moveReview.acceptDraft, false);
  assert.deepEqual(moveReview.moves, [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }]);
  assert.match(moveReview.notes, /E2E placeholder/);
  const singleRowReview = JSON.parse(await session.prompt(messages([firstRow]), options));
  assert.equal(singleRowReview.acceptDraft, true);
  assert.deepEqual(singleRowReview.moves, []);
  const fragmentReview = JSON.parse(await session.prompt(messages([firstRow.replace('Первое предложение. Второе предложение.', 'Незавершённая фраза'), secondRow]), options));
  assert.equal(fragmentReview.acceptDraft, true);
  assert.deepEqual(fragmentReview.moves, []);
  let text = '';
  for await (const chunk of session.promptStreaming([])) text += chunk;
  assert.match(text, /E2E placeholder/);
  session.destroy();
  await assert.rejects(session.prompt([]), /destroyed/);
});

test('local successful transcription comes from configured upstream and invalid model output fails closed', async t => {
  const actual = { taskId: 'task', tracks: payload.tracks.map(track => ({ lane: track.lane, tokens: [{ id: `${track.lane}:0`, text: 'Результат', startSeconds: 0.2, endSeconds: 0.8 }] })), summary: { provider: 'controlled-local' }, models: { asr: { name: 'controlled-asr' } } };
  let valid = true;
  const local = await upstream(t, (req, res) => {
    if (req.url === '/health') return json(res, { ok: true, device: 'cpu', models: { asr: 'controlled' } });
    assert.equal(req.url, '/v1/transcribe');
    return json(res, valid ? actual : { taskId: 'task', tracks: [] });
  });
  const gateway = await createProviderGateway({ ai: 'local', localEngineUrl: local.url });
  const result = await gateway.request({ kind: 'local-transcribe', body: payload, audioTracks });
  assert.deepEqual(result.body, actual);
  valid = false;
  await assert.rejects(gateway.request({ kind: 'local-transcribe', body: payload, audioTracks }), /Invalid local transcription/);
});

test('review finalization preserves reviewer comments and generates separately decidable card suggestions', async () => {
  const gateway = await createProviderGateway();
  const session = { cards: [{ id: 'card1', changeIndex: 1, categories: ['Word Accuracy'] }, { id: 'card2', changeIndex: 2, categories: ['Segmentation'] }], comments: { sessionComment: 'Общий комментарий', cardComments: { card1: 'Исправить первое слово', card2: 'Разделить фразу' } } };
  const result = await gateway.request({ kind: 'review', body: { session } });
  assert.equal(result.body.llm.feedback.length, 5);
  assert.ok(result.body.llm.feedback.every(item => item.score >= 1 && item.score <= 3 && item.note.includes('Общий комментарий')));
  assert.match(result.body.llm.feedback.find(item => item.category === 'Word Accuracy').note, /Исправить первое слово/);
  assert.match(result.body.llm.feedback.find(item => item.category === 'Segmentation').note, /Разделить фразу/);
  const { suggestions } = (await gateway.request({ kind: 'review-suggestions', body: { session } })).body;
  assert.deepEqual(suggestions.map(item => item.sourceCardIds), [['card1'], ['card2']]);
  assert.notEqual(suggestions[0].proposalId, suggestions[1].proposalId);
  assert.match(suggestions[1].reason, /Разделить фразу/);
});

function throughFence(fence, url, { agent, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(fence.url, { path: url, agent, method, headers }, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

test('network fence preserves HTTP status and owns keep-alive independently of upstream close', { timeout: 5000 }, async t => {
  const local = await upstream(t, (req, res) => {
    assert.equal(req.headers['x-client-hop'], undefined);
    json(res, { error: 'Not deployed' }, 404, { connection: 'close, x-origin-hop', 'x-origin-hop': 'private', 'keep-alive': 'timeout=1' });
  });
  const events = [];
  const fence = await startNetworkFence({ allowedOrigins: [local.url], events });
  t.after(() => fence.close());
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let socket;
  for (let index = 0; index < 2; index++) {
    const response = await throughFence(fence, `${local.url}/api/review/grade`, {
      agent, headers: { connection: 'keep-alive, x-client-hop', 'x-client-hop': 'private' }
    });
    if (socket) assert.equal(response.socket, socket, 'origin close must not close the browser-facing connection');
    else socket = response.socket;
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['x-origin-hop'], undefined);
    assert.notEqual(response.headers['keep-alive'], 'timeout=1');
    assert.deepEqual(JSON.parse(await responseText(response)), { error: 'Not deployed' });
  }
  for (const url of ['http://example.invalid/denied', `${local.url}/__e2e__/control`, `${local.url}/__e2e__/reset`]) {
    const response = await throughFence(fence, url, { agent });
    assert.equal(response.statusCode, 403);
    assert.match(await responseText(response), /network fence/);
  }
  await new Promise((resolve, reject) => {
    const request = httpRequest(fence.url, { method: 'CONNECT', path: 'example.invalid:443', agent: false });
    request.on('error', reject);
    request.on('connect', (response, socket) => {
      socket.destroy();
      try { assert.equal(response.statusCode, 403); resolve(); } catch (error) { reject(error); }
    });
    request.end();
  });
  assert.deepEqual(local.calls.map(call => call.path), ['/api/review/grade', '/api/review/grade']);
  assert.deepEqual(events.filter(event => event.type === 'network-denied').map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: 'http://example.invalid/denied' },
    { method: 'GET', url: `${local.url}/__e2e__/control` },
    { method: 'GET', url: `${local.url}/__e2e__/reset` },
    { method: 'CONNECT', url: 'https://example.invalid:443' }
  ]);
});

test('network fence cancels completed uploads while waiting for or streaming a response', async t => {
  for (const phase of ['before-headers', 'streaming']) await t.test(phase, { timeout: 5000 }, async t => {
    let receive;
    const received = new Promise(resolve => { receive = resolve; });
    const local = await upstream(t, (_req, res) => {
      if (_req.url === '/grade') return json(res, { error: 'Not deployed' }, 404);
      if (phase === 'streaming') res.writeHead(200).write('partial response');
      receive(res);
    });
    const fence = await startNetworkFence({ allowedOrigins: [local.url] });
    t.after(() => fence.close());
    const request = httpRequest(fence.url, { path: `${local.url}/cancel`, method: 'POST' });
    request.on('error', error => assert.equal(error.code, 'ECONNRESET'));
    const incoming = phase === 'streaming' ? once(request, 'response') : undefined;
    request.end('completed upload');
    const originResponse = await received;
    assert.equal(request.writableFinished, true);
    assert.equal(local.calls[0].body.toString(), 'completed upload');
    const closed = once(originResponse, 'close', { signal: t.signal });
    if (incoming) (await incoming)[0].destroy();
    else request.destroy();
    await closed;
    assert.equal(originResponse.writableFinished, false, 'cancellation must not wait for an upstream response to finish');
    const response = await throughFence(fence, `${local.url}/grade`);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(await responseText(response)), { error: 'Not deployed' });
  });
});

test('network fence terminates truncated responses without poisoning the next allowed request', { timeout: 5000 }, async t => {
  let originResponse;
  const local = await upstream(t, (req, res) => {
    if (req.url === '/grade') return json(res, { error: 'Not deployed' }, 404);
    originResponse = res;
    res.writeHead(200, { 'content-length': '100' });
    res.write('incomplete');
  });
  const fence = await startNetworkFence({ allowedOrigins: [local.url] });
  t.after(() => fence.close());
  const response = await throughFence(fence, `${local.url}/truncated`);
  const interrupted = assert.rejects(responseText(response), { code: 'ECONNRESET' });
  originResponse.destroy();
  await interrupted;
  const next = await throughFence(fence, `${local.url}/grade`);
  assert.equal(next.statusCode, 404);
  assert.deepEqual(JSON.parse(await responseText(next)), { error: 'Not deployed' });
});

test('closing one network fence releases its upstream sockets without borrowing another fence transport', { timeout: 5000 }, async t => {
  const sockets = new Map();
  const local = await upstream(t, (req, res) => {
    sockets.set(req.url, req.socket);
    if (req.url === '/pending') res.writeHead(200).write('pending');
    else json(res, { error: 'Not deployed' }, 404);
  });
  const first = await startNetworkFence({ allowedOrigins: [local.url] });
  const second = await startNetworkFence({ allowedOrigins: [local.url] });
  t.after(() => first.close());
  t.after(() => second.close());
  await responseText(await throughFence(first, `${local.url}/first`));
  await responseText(await throughFence(second, `${local.url}/second`));
  assert.notEqual(sockets.get('/first'), sockets.get('/second'), 'fences must not share the global HTTP agent');
  const pending = await throughFence(first, `${local.url}/pending`);
  const interrupted = assert.rejects(responseText(pending), { code: 'ECONNRESET' });
  await responseText(await throughFence(first, `${local.url}/idle`));
  const activeClosed = once(sockets.get('/pending'), 'close', { signal: t.signal });
  const idleClosed = once(sockets.get('/idle'), 'close', { signal: t.signal });
  await first.close();
  await Promise.all([activeClosed, idleClosed, interrupted]);
  assert.equal(sockets.get('/second').destroyed, false);
  const response = await throughFence(second, `${local.url}/grade`);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(await responseText(response)), { error: 'Not deployed' });
});
