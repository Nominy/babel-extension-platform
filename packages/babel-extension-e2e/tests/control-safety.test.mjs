import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { startScenarioServer } from '../src/server.mjs';

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
