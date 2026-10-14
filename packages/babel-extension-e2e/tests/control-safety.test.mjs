import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { startScenarioServer } from '../src/server.mjs';
import { createHash } from 'node:crypto';
import { makeWav } from '../src/scenarios.mjs';

function rawRequest(baseURL, target, body, origin) {
  const url = new URL(baseURL);
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      method: bytes ? 'POST' : 'GET',
      // Pass the raw HTTP target: new URL(target, baseURL) would normalize away the attack.
      path: target,
      headers: {
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Local control request timed out')));
    req.end(bytes ?? undefined);
  });
}

test('normal Node control works while authority and backslash targets cannot mutate scenario state', async (t) => {
  const server = await startScenarioServer();
  t.after(() => server.close());

  const reset = await rawRequest(server.url, '/__e2e__/reset', { scenario: 'readonly' });
  assert.equal(reset.status, 200);
  assert.equal(JSON.parse(reset.body).scenario, 'readonly');
  const controls = { routes: { '/audio/speaker-1.wav': { delayMs: 25, times: 1 } } };
  const controlled = await rawRequest(server.url, '/__e2e__/control', controls);
  assert.equal(controlled.status, 200);
  assert.deepEqual(JSON.parse(controlled.body).controls.routes, controls.routes);
  const before = JSON.parse((await rawRequest(server.url, '/__e2e__/state')).body);

  const attacks = [
    ['//ignored/__e2e__/control', { routes: {} }],
    ['//ignored/__e2e__/reset', { scenario: 'empty' }],
    ['/\\ignored/__e2e__/control', { routes: {} }],
    ['\\\\ignored\\__e2e__\\reset', { scenario: 'empty' }],
    ['http://ignored/__e2e__/reset', { scenario: 'empty' }],
  ];
  for (const [target, body] of attacks) {
    const response = await rawRequest(server.url, target, body, 'http://127.0.0.1:5173');
    assert.equal(response.status, 400, `raw request target must be rejected: ${target}`);
    assert.deepEqual(JSON.parse((await rawRequest(server.url, '/__e2e__/state')).body), before, `rejected target must not alter state: ${target}`);
  }

  const cleared = await rawRequest(server.url, '/__e2e__/control', { routes: {} });
  assert.equal(cleared.status, 200);
  const clearedState = JSON.parse(cleared.body);
  assert.deepEqual(clearedState.controls.routes, {});
  assert.equal(clearedState.scenario, 'readonly');
});

test('chunk audio lookup returns playable scenario audio and rejects recordings outside the requested action', async (t) => {
  const server = await startScenarioServer();
  t.after(() => server.close());
  const reset = await rawRequest(server.url, '/__e2e__/reset', {
    scenario: 'baseline',
    overrides: { referenceAction: { transcriptionChunkProcessedRecordings: [] } },
  });
  const state = JSON.parse(reset.body);
  const query = (reviewActionId, chunkedProcessedRecordingIds) => rawRequest(server.url,
    '/api/trpc/transcriptions.getPresignedChunkUrls?input=' + encodeURIComponent(JSON.stringify({
      json: { reviewActionId, chunkedProcessedRecordingIds },
    })));
  const recording = state.action.transcriptionChunkProcessedRecordings[0];
  const resolved = await query(state.action.actionId, [recording.chunkedProcessedRecordingId]);
  assert.equal(resolved.status, 200);
  const urls = JSON.parse(resolved.body).result.data.json;
  assert.deepEqual(urls, { [recording.chunkedProcessedRecordingId]: recording.processedRecordingUrl });
  const audio = await fetch(urls[recording.chunkedProcessedRecordingId]);
  assert.equal(audio.status, 200);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal((await query(state.referenceAction.actionId, [recording.chunkedProcessedRecordingId])).status, 404);
  assert.equal((await query(state.action.actionId, ['missing-recording'])).status, 404);
  assert.equal((await query('missing-action', [recording.chunkedProcessedRecordingId])).status, 404);
  assert.equal((await query(state.action.actionId, 'not-an-array')).status, 400);
});

test('enhancement fixture verifies Original bytes, returns same-clock PCM and protects queue ownership', async (t) => {
  const server = await startScenarioServer();
  t.after(() => server.close());
  const audio = { duration: 1, sampleRate: 16000, voicedWindows: { 'speaker-1': [[0, 1]], 'speaker-2': [[0, 1]] } };
  const sources = [1, 2].map(speaker => makeWav(speaker, audio));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const payload = { taskId: 'synthetic-enhancement-task', model: { id: 'e2e-model', sha256: 'a'.repeat(64) },
    tracks: sources.map((bytes, index) => ({ trackId: `speaker-${index + 1}`, speakerKey: `speaker-${index + 1}`,
      trackLabel: `Speaker ${index + 1}`, fieldName: `audio:${index + 1}`, sourceSha256: hash(bytes),
      sampleRate: audio.sampleRate, frameCount: audio.sampleRate })) };
  const requestBody = (data = payload) => {
    const form = new FormData();
    form.append('payload', JSON.stringify(data));
    sources.forEach((bytes, index) => form.append(`audio:${index + 1}`, new Blob([bytes], { type: 'audio/wav' }), `${index + 1}.wav`));
    return form;
  };
  const owner = `Bearer ${'a'.repeat(43)}`;
  const endpoint = `${server.url}/v1/enhance`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'X-Babel-Request-Id': 'denied' }, body: requestBody() })).status, 401);
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: owner, 'X-Babel-Request-Id': 'enhance' }, body: requestBody() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-babel-e2e-inference'), 'placeholder');
  const form = await response.formData();
  const result = JSON.parse(form.get('result'));
  assert.equal(result.taskId, payload.taskId);
  for (const [index, track] of result.tracks.entries()) {
    const bytes = Buffer.from(await form.get(`audio:${index + 1}`).arrayBuffer());
    assert.equal(track.wavSha256, hash(bytes));
    assert.equal(track.sourceSha256, hash(sources[index]));
    assert.equal(track.sampleRate, audio.sampleRate);
    assert.equal(track.frameCount, audio.sampleRate);
    assert.equal(bytes.length, 44 + audio.sampleRate * 2);
    for (const frame of [101, 1001, 2001]) {
      assert.equal(bytes.readInt16LE(44 + frame * 2), Math.round(sources[index].readInt16LE(44 + frame * 2) / 2));
    }
  }
  assert.equal((await fetch(`${server.url}/v1/queue/enhance`)).status, 403);
  const status = await fetch(`${server.url}/v1/queue/enhance`, { headers: { Authorization: owner } });
  assert.equal((await status.json()).status, 'completed');
  const corrupt = structuredClone(payload);
  corrupt.tracks[0].sourceSha256 = '0'.repeat(64);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: owner, 'X-Babel-Request-Id': 'corrupt' }, body: requestBody(corrupt) })).status, 400);
  const state = await (await fetch(`${server.url}/__e2e__/state`)).text();
  assert.equal(state.includes(owner), false);
});
