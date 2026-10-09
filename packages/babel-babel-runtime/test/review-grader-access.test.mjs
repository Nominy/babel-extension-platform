import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewGraderAccess,
  REVIEW_GRADER_EXTENSION_ID,
  REVIEW_GRADER_ACCESS_PORT,
  REVIEW_GRADER_ACCESS_CAPABILITY,
  REVIEW_GRADER_ACCESS_TIMEOUT_MS,
  REVIEW_GRADER_ACCESS_HEARTBEAT_MS,
  REVIEW_GRADER_ACCESS_RETRY_MS,
  isReviewGraderAccessRequest,
  isReviewGraderAccessReply
} from '../src/index.mjs';

class Clock {
  now = 0;
  next = 0;
  tasks = new Map();
  setTimeout(callback, delay) {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  advance(delay) {
    const target = this.now + delay;
    for (;;) {
      const due = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

class Event {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

class Port {
  name = REVIEW_GRADER_ACCESS_PORT;
  onMessage = new Event();
  onDisconnect = new Event();
  messages = [];
  disconnected = false;
  postMessage(message) {
    if (this.disconnected) throw new Error('Disconnected');
    this.messages.push(structuredClone(message));
  }
  disconnect() { this.disconnected = true; }
  reply(overrides = {}) {
    this.onMessage.emit({ ...this.messages.at(-1), type: 'grant', ...overrides });
  }
  drop() {
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

function fixture(t, options = {}) {
  const clock = new Clock();
  const calls = [];
  let nonce = 0;
  let errorsRead = 0;
  const runtime = {
    get lastError() { errorsRead++; return { message: 'Could not establish connection. Receiving end does not exist.' }; },
    connect(id, info) {
      const port = new Port();
      calls.push({ id, info, port });
      options.connect?.(port);
      return port;
    }
  };
  const access = createReviewGraderAccess(runtime, {
    timers: clock,
    createNonce: () => (++nonce).toString(16).padStart(32, '0'),
    ...options.access
  });
  t.after(() => access.dispose());
  return { access, clock, calls, errorsRead: () => errorsRead, port: () => calls.at(-1).port };
}

test('constructs without browser resources and only a nonce-bound external grant opens access', async t => {
  const f = fixture(t);
  assert.equal(f.access.isAvailable(), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.clock.tasks.size, 0);
  const changes = [];
  const unsubscribe = f.access.subscribe(value => changes.push(value));
  const pending = f.access.start();
  assert.deepEqual(changes, [false]);
  assert.equal(f.access.isAvailable(), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, REVIEW_GRADER_EXTENSION_ID);
  assert.deepEqual(f.calls[0].info, { name: REVIEW_GRADER_ACCESS_PORT });
  assert.equal(isReviewGraderAccessRequest(f.port().messages[0]), true);
  assert.equal(f.port().messages[0].capability, REVIEW_GRADER_ACCESS_CAPABILITY);
  const acquiring = f.access.acquire();
  f.port().reply();
  assert.equal(await pending, true);
  const signal = await acquiring;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.equal(await f.access.acquire(), signal);
  assert.deepEqual(changes, [false, true]);
  unsubscribe();
  f.port().drop();
  assert.equal(signal.aborted, true);
  assert.deepEqual(changes, [false, true]);
});

test('heartbeats preserve the lease and missing replies revoke before reconnecting with a fresh nonce', async t => {
  const f = fixture(t);
  const initial = f.access.start();
  f.port().reply();
  await initial;
  const signal = await f.access.acquire();
  const firstPort = f.port();
  const nonce = firstPort.messages[0].nonce;
  f.clock.advance(REVIEW_GRADER_ACCESS_HEARTBEAT_MS);
  assert.equal(firstPort.messages[1].type, 'heartbeat');
  assert.equal(firstPort.messages[1].sequence, 1);
  assert.equal(firstPort.messages[1].nonce, nonce);
  firstPort.reply();
  assert.equal(await f.access.acquire(), signal);
  assert.equal(signal.aborted, false);
  f.clock.advance(REVIEW_GRADER_ACCESS_HEARTBEAT_MS + REVIEW_GRADER_ACCESS_TIMEOUT_MS);
  assert.equal(signal.aborted, true);
  assert.equal(f.access.isAvailable(), false);
  assert.equal(await f.access.acquire(), null);
  assert.equal(firstPort.disconnected, true);
  f.clock.advance(REVIEW_GRADER_ACCESS_RETRY_MS);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.port().messages[0].nonce, nonce);
  firstPort.reply();
  assert.equal(f.access.isAvailable(), false);
  f.port().reply();
  const nextSignal = await f.access.acquire();
  assert.notEqual(nextSignal, signal);
  assert.equal(nextSignal.aborted, false);
});

test('missing target consumes lastError quietly and a later install can grant without recreating the gate', async t => {
  const f = fixture(t);
  const changes = [];
  f.access.subscribe(value => changes.push(value));
  const initial = f.access.start();
  f.port().drop();
  assert.equal(await initial, false);
  assert.equal(f.errorsRead(), 1);
  assert.equal(await f.access.acquire(), null);
  assert.deepEqual(changes, [false]);
  f.clock.advance(REVIEW_GRADER_ACCESS_RETRY_MS);
  f.port().reply();
  assert.equal(f.access.isAvailable(), true);
  const signal = await f.access.acquire();
  f.port().drop();
  assert.equal(signal.aborted, true);
  assert.deepEqual(changes, [false, true, false]);
});

test('initial handshake is bounded even when a connected provider stays silent', async t => {
  const f = fixture(t);
  const initial = f.access.start();
  f.clock.advance(REVIEW_GRADER_ACCESS_TIMEOUT_MS);
  assert.equal(await initial, false);
  assert.equal(f.access.isAvailable(), false);
  assert.equal(f.port().disconnected, true);
  assert.equal(f.port().onMessage.listeners.size, 0);
  assert.equal(f.port().onDisconnect.listeners.size, 0);
});

test('wrong nonce, protocol, capability, sequence and malformed or unknown replies all fail closed', async t => {
  const badReplies = [
    null, [], true, 'grant', {},
    { nonce: 'f'.repeat(32) }, { version: 2 }, { capability: 'grading' },
    { sequence: 1 }, { sequence: -1 }, { sequence: 0.5 },
    { type: 'request' }, { type: 'approved' }, { type: 'revoke' }, { extra: true }
  ];
  for (const bad of badReplies) {
    await t.test(JSON.stringify(bad), async child => {
      const f = fixture(child);
      const initial = f.access.start();
      if (bad === null || typeof bad !== 'object' || Array.isArray(bad) || Object.keys(bad).length === 0) {
        f.port().onMessage.emit(bad);
      } else {
        f.port().reply(bad);
      }
      assert.equal(await initial, false);
      assert.equal(await f.access.acquire(), null);
      assert.equal(f.port().disconnected, true);
    });
  }
});

test('a replayed grant or an explicit revocation immediately aborts an existing lease', async t => {
  for (const type of ['grant', 'revoke']) {
    await t.test(type, async child => {
      const f = fixture(child);
      const initial = f.access.start();
      f.port().reply();
      await initial;
      const signal = await f.access.acquire();
      f.port().reply({ type });
      assert.equal(signal.aborted, true);
      assert.equal(f.access.isAvailable(), false);
    });
  }
});

test('a port with an unexpected target sender or port name cannot grant', async t => {
  for (const configure of [port => { port.sender = { id: 'counterfeit' }; }, port => { port.name = 'page-bridge'; }]) {
    const f = fixture(t, { connect: configure });
    assert.equal(await f.access.start(), false);
    assert.equal(f.port().messages.length, 0);
    assert.equal(f.port().disconnected, true);
  }
});

test('connect exceptions and unavailable secure randomness stay closed', async t => {
  for (const options of [
    { connect() { throw new Error('Extension context invalidated'); } },
    { access: { createNonce() { throw new Error('No secure randomness'); } } },
    { access: { createNonce: () => 'not-a-nonce' } }
  ]) {
    const f = fixture(t, options);
    assert.equal(await f.access.start(), false);
    assert.equal(await f.access.acquire(), null);
    assert.equal(f.access.isAvailable(), false);
  }
});

test('runtime-less Node access fails closed without any timer or nonce work', async () => {
  const access = createReviewGraderAccess(undefined, {
    timers: { setTimeout() { assert.fail('No runtime must not poll'); }, clearTimeout() {} },
    createNonce() { assert.fail('No runtime must not allocate a nonce'); }
  });
  assert.equal(await access.start(), false);
  assert.equal(await access.acquire(), null);
  access.dispose();
});

test('dispose settles a pending handshake, clears resources and never restarts', async t => {
  const f = fixture(t);
  const pending = f.access.start();
  const port = f.port();
  f.access.dispose();
  assert.equal(await pending, false);
  assert.equal(f.clock.tasks.size, 0);
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
  assert.equal(port.disconnected, true);
  assert.equal(await f.access.start(), false);
  assert.equal(await f.access.acquire(), null);
  f.access.subscribe(() => assert.fail('Disposed gate cannot subscribe'));
  f.clock.advance(60000);
  assert.equal(f.calls.length, 1);
});

test('disposal aborts the active lease even when subscribers throw', async t => {
  const f = fixture(t);
  const values = [];
  f.access.subscribe(() => { throw new Error('Consumer failure'); });
  f.access.subscribe(value => values.push(value));
  f.port().reply();
  const signal = await f.access.acquire();
  f.access.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(values, [false, true, false]);
  assert.equal(f.clock.tasks.size, 0);
});

test('synchronous disposal from a grant subscriber cannot leave timers or a live lease', async t => {
  const f = fixture(t);
  f.access.subscribe(value => { if (value) f.access.dispose(); });
  const pending = f.access.start();
  f.port().reply();
  assert.equal(await pending, false);
  assert.equal(f.access.isAvailable(), false);
  assert.equal(f.clock.tasks.size, 0);
});

test('schema helpers distinguish explicit grants from unrelated enhancement messages', () => {
  const request = { version: 1, type: 'request', capability: REVIEW_GRADER_ACCESS_CAPABILITY, nonce: 'a'.repeat(32), sequence: 0 };
  assert.equal(isReviewGraderAccessRequest(request), true);
  assert.equal(isReviewGraderAccessReply(request), false);
  assert.equal(isReviewGraderAccessReply({ ...request, type: 'grant' }), true);
  assert.equal(isReviewGraderAccessRequest({ ...request, type: 'heartbeat' }), false);
  assert.equal(isReviewGraderAccessRequest({ ...request, type: 'heartbeat', sequence: 1 }), true);
  assert.equal(isReviewGraderAccessRequest({ ...request, sequence: 1 }), false);
  const inherited = Object.assign(Object.create({ type: 'grant' }), {
    version: 1, capability: REVIEW_GRADER_ACCESS_CAPABILITY, nonce: request.nonce, sequence: 0, extra: true
  });
  assert.equal(isReviewGraderAccessReply(inherited), false);
});
