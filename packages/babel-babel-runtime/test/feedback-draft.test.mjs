import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireFeedbackDraftGate } from '../src/index.mjs';

const STEP = 'feedback-step';
const INPUTS = [{ id: 'word', label: 'Word Accuracy', type: 'rating' }, { id: 'comment', label: 'Word Accuracy Comment', type: 'textarea' }];
const DEFINITIONS = '/api/trpc/forms.getFormInputsByStepId?batch=1&input=' + encodeURIComponent(JSON.stringify({ 0: { json: { stepId: STEP } } }));
const DRAFT = '/api/trpc/transcriptionFeedbackForm.getOrCreateDraft?batch=1';
const BODY = JSON.stringify({ 0: { json: { formStepId: STEP, reviewActionId: 'task-a' } } });

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture(t) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousNow = Date.now;
  let now = 10000, timerId = 0;
  const timers = new Map(), requests = [], leases = [];
  const win = new EventTarget();
  const nativeFetch = (input, init) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    requests.push({ input, init, resolve, reject }); return promise;
  };
  Object.assign(win, {
    fetch: nativeFetch,
    location: { origin: 'https://babel.test', pathname: '/transcription/test', search: '?reviewActionId=task-a' },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  const observer = { options: { queryKey: [['forms', 'getFormInputsByStepId'], { input: { stepId: STEP } }] }, data: undefined, getCurrentResult() { return { data: this.data }; } };
  const labels = { current: null };
  const draft = { options: { mutationKey: [['transcriptionFeedbackForm', 'getOrCreateDraft']] } };
  const hooks = [observer, labels, draft].map(memoizedState => ({ memoizedState, next: null }));
  hooks.forEach((hook, index) => { hook.next = hooks[index + 1] ?? null; });
  const root = { memoizedProps: {}, child: null, stateNode: {} }; root.stateNode.current = root;
  root.child = { return: root, memoizedProps: { reviewActionId: 'task-a', transcriptionChunkProcessedRecordings: [] }, memoizedState: hooks[0] };
  const doc = { querySelectorAll: () => [{ __reactFiber$gate: { return: root.child } }] };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Date.now = () => now;
  t.after(() => {
    for (const lease of leases) lease.dispose();
    Date.now = previousNow;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  });
  return {
    win, nativeFetch, observer, labels, requests, timers,
    acquire(owner, enabled = true) { const lease = acquireFeedbackDraftGate(owner, enabled); leases.push(lease); return lease; },
    commit() { observer.data = INPUTS; labels.current = INPUTS.map(({ id, label }) => ({ id, label })); },
    async tick(elapsed = 25) {
      await flush(); now += elapsed;
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await flush();
    },
    async request(url, init) {
      const promise = win.fetch(url, init); await flush();
      return { promise, upstream: requests.at(-1) };
    }
  };
}

for (const order of [['helper', 'review'], ['review', 'helper']]) {
  test(`shared gate holds through Helper opt-out when Review remains enabled (${order.join(' then ')})`, async t => {
    const f = fixture(t);
    const owners = Object.fromEntries(order.map(owner => [owner, f.acquire(owner)]));
    const definitions = await f.request(DEFINITIONS);
    const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
    const response = new Response('unchanged saved draft');
    draft.upstream.resolve(response); await flush();
    assert.equal(owners.review.getDiagnostics().pendingHolds, 1);
    owners.helper.setEnabled(false);
    assert.equal(owners.helper.getDiagnostics().enabled, false);
    assert.equal(owners.helper.getDiagnostics().effectiveEnabled, true);
    assert.equal(owners.review.getDiagnostics().pendingHolds, 1);
    definitions.upstream.resolve(new Response('definitions')); await definitions.promise;
    f.observer.data = INPUTS; await f.tick();
    assert.equal(owners.review.getDiagnostics().pendingHolds, 1, 'query arrival alone does not populate the native labels ref');
    f.commit(); await f.tick();
    assert.equal(await draft.promise, response);
    assert.equal(await response.text(), 'unchanged saved draft');
    assert.equal(f.requests.length, 2);
    assert.equal(owners.review.getDiagnostics().last.reason, 'committed');
    owners.review.dispose();
    assert.equal(f.win.fetch, f.nativeFetch);
    assert.equal(f.timers.size, 0);
  });
}

test('Helper-only disable releases held response immediately and leaves native fetch unmodified', async t => {
  const f = fixture(t), lease = f.acquire('helper');
  const definitions = await f.request(DEFINITIONS);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response('draft'); draft.upstream.resolve(response); await flush();
  assert.equal(lease.getDiagnostics().pendingHolds, 1);
  lease.setEnabled(false);
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'disabled');
  assert.equal(f.win.fetch, f.nativeFetch);
  assert.equal(f.timers.size, 0);
  definitions.upstream.resolve(new Response()); await definitions.promise;
});

test('duplicate acquisitions are independent leases, not an owner-name overwrite', async t => {
  const f = fixture(t), first = f.acquire('review'), second = f.acquire('review');
  const wrapper = f.win.fetch;
  first.dispose(); assert.equal(f.win.fetch, wrapper);
  assert.equal(second.getDiagnostics().effectiveEnabled, true);
  second.dispose(); assert.equal(f.win.fetch, f.nativeFetch);
});

test('disabling a buried gate never clobbers a foreign wrapper or creates recursive fetch chains', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const gate = f.win.fetch; let foreignCalls = 0;
  const foreign = (...args) => { foreignCalls++; return gate(...args); };
  f.win.fetch = foreign;
  lease.setEnabled(false); assert.equal(f.win.fetch, foreign);
  lease.setEnabled(true); assert.equal(f.win.fetch, foreign);
  f.commit();
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response('draft'); draft.upstream.resolve(response);
  assert.equal(await draft.promise, response);
  lease.dispose(); assert.equal(f.win.fetch, foreign);
  const plain = await f.request('/unrelated'); plain.upstream.resolve(response);
  assert.equal(await plain.promise, response);
  assert.equal(foreignCalls, 2); assert.equal(f.requests.length, 2);
});

test('a gate installed above an existing wrapper restores exactly that wrapper', async t => {
  const f = fixture(t); let foreignCalls = 0;
  const foreign = (...args) => { foreignCalls++; return f.nativeFetch(...args); };
  f.win.fetch = foreign;
  const lease = f.acquire('review'); f.commit();
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response);
  assert.equal(await draft.promise, response);
  lease.dispose(); assert.equal(f.win.fetch, foreign); assert.equal(foreignCalls, 1);
});

test('task navigation releases the old draft without using another task definitions', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const definitions = await f.request(DEFINITIONS);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response); await flush();
  f.win.location.search = '?reviewActionId=task-b'; f.win.dispatchEvent(new Event('popstate'));
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'stale-task');
  assert.equal(f.timers.size, 0);
  definitions.upstream.resolve(new Response()); await definitions.promise;
});

test('upstream failure is propagated once and a failed definitions request releases draft untouched', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const definitions = await f.request(DEFINITIONS);
  const rejected = assert.rejects(definitions.promise, /offline/);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response); await flush();
  definitions.upstream.reject(new Error('offline')); await rejected; await flush();
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'definitions-failed');
  assert.equal(f.requests.length, 2);
});

test('combined definitions and draft batch is never held on itself', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const request = await f.request('/api/trpc/forms.getFormInputsByStepId,transcriptionFeedbackForm.getOrCreateDraft?batch=1', { method: 'POST', body: BODY });
  const response = new Response(); request.upstream.resolve(response);
  assert.equal(await request.promise, response);
  assert.equal(lease.getDiagnostics().pendingHolds, 0);
});

test('bounded hold releases untouched when native definitions never commit', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const definitions = await f.request(DEFINITIONS);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response); await flush();
  await f.tick(8001);
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'timeout');
  definitions.upstream.resolve(new Response()); await definitions.promise;
});

test('Request input inspection clones the body and preserves the original request', async t => {
  const f = fixture(t); f.acquire('review'); f.commit();
  const request = new Request('https://babel.test' + DRAFT, { method: 'POST', body: BODY });
  const pending = f.win.fetch(request);
  // Request.clone().text() uses native asynchronous stream tasks, not the gate clock.
  for (let count = 0; count < 20 && !f.requests.length; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].input, request);
  assert.equal(request.bodyUsed, false);
  const response = new Response('saved'); f.requests[0].resolve(response);
  assert.equal(await pending, response);
  assert.equal(await request.text(), BODY);
});

test('pagehide releases holds and pageshow restores protection for remaining leases', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const definitions = await f.request(DEFINITIONS);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response); await flush();
  f.win.dispatchEvent(new Event('pagehide'));
  assert.equal(await draft.promise, response); assert.equal(f.win.fetch, f.nativeFetch);
  assert.equal(lease.getDiagnostics().effectiveEnabled, false);
  f.win.dispatchEvent(new Event('pageshow'));
  assert.notEqual(f.win.fetch, f.nativeFetch); assert.equal(lease.getDiagnostics().effectiveEnabled, true);
  definitions.upstream.resolve(new Response()); await definitions.promise;
});

test('malformed draft input remains untouched and is fetched exactly once', async t => {
  const f = fixture(t), lease = f.acquire('review'); f.commit();
  const init = { method: 'POST', body: '{invalid-json' };
  const draft = await f.request(DRAFT, init);
  const response = new Response('native validation error', { status: 400 });
  draft.upstream.resolve(response);
  assert.equal(await draft.promise, response);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init, init);
  assert.equal(lease.getDiagnostics().lastError.stage, 'draft-request');
});

test('empty committed field definitions release a draft without requiring a nonempty label ref', async t => {
  const f = fixture(t), lease = f.acquire('review');
  f.observer.data = [];
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response);
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'committed');
  assert.equal(f.timers.size, 0);
});

test('delivered definitions get a bounded native commit grace before an untouched release', async t => {
  const f = fixture(t), lease = f.acquire('review');
  const definitions = await f.request(DEFINITIONS);
  const draft = await f.request(DRAFT, { method: 'POST', body: BODY });
  const response = new Response(); draft.upstream.resolve(response); await flush();
  definitions.upstream.resolve(new Response()); await definitions.promise; await flush();
  await f.tick(1499);
  assert.equal(lease.getDiagnostics().pendingHolds, 1);
  await f.tick(2);
  assert.equal(await draft.promise, response);
  assert.equal(lease.getDiagnostics().last.reason, 'commit-grace-elapsed');
});
