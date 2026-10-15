import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeBabelEditorCommits, readBabelSessionState } from '../src/index.mjs';

function fixture() {
  const transcript = { memoizedProps: { turns: [], editingId: null,
    handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} } } };
  const panel = { memoizedProps: { annotations: [], saveState: {}, renderTranscript() {}, onSave() {} }, child: transcript };
  const editor = { memoizedProps: { reviewActionId: 'a', transcriptionChunkProcessedRecordings: [] }, child: panel };
  const root = { child: editor };
  const host = { current: root };
  root.stateNode = host;
  editor.return = root;
  panel.return = editor;
  transcript.return = panel;
  const seed = { __reactFiber$native: editor };
  const document = { querySelectorAll() { return [seed]; } };
  return { host, root, editor, panel, transcript, seed, document };
}

test('same-pointer native commits publish current task and permissions after synchronous work completes', async () => {
  const m = fixture();
  const states = [];
  const stop = subscribeBabelEditorCommits(() => states.push(readBabelSessionState(m.document)), m.document);
  m.host.current = m.root;
  m.editor.memoizedProps.reviewActionId = 'b';
  m.transcript.memoizedProps.readOnly = true;
  m.host.current = m.root;
  assert.deepEqual(states, []);
  await Promise.resolve();
  assert.deepEqual(states, [{ reviewActionId: 'b', readOnly: true }]);
  m.transcript.memoizedProps.readOnly = false;
  m.host.current = m.root;
  await Promise.resolve();
  assert.equal(states[1].readOnly, false);
  stop();
});

test('independent bundles share one property lease and restore the latest committed root', async () => {
  const other = await import('../src/index.mjs?independent-commit-bundle');
  const m = fixture();
  const original = Object.getOwnPropertyDescriptor(m.host, 'current');
  let first = 0, second = 0;
  const stopFirst = subscribeBabelEditorCommits(() => first++, m.document);
  const descriptor = Object.getOwnPropertyDescriptor(m.host, 'current');
  const stopSecond = other.subscribeBabelEditorCommits(() => second++, m.document);
  assert.equal(Object.getOwnPropertyDescriptor(m.host, 'current').set, descriptor.set);
  const nextRoot = { child: m.editor, stateNode: m.host };
  m.host.current = nextRoot;
  stopFirst();
  await Promise.resolve();
  assert.equal(first, 0);
  assert.equal(second, 1);
  stopFirst();
  assert.equal(Object.getOwnPropertyDescriptor(m.host, 'current').set, descriptor.set);
  stopSecond();
  assert.deepEqual(Object.getOwnPropertyDescriptor(m.host, 'current'), { ...original, value: nextRoot });
});

test('queued work cannot survive disposal or notify the replacement root subscription', async () => {
  const old = fixture(), next = fixture();
  let oldCalls = 0, nextCalls = 0;
  const stopOld = subscribeBabelEditorCommits(() => oldCalls++, old.document);
  old.host.current = old.root;
  stopOld();
  old.seed.__reactFiber$native = next.editor;
  const stopNext = subscribeBabelEditorCommits(() => nextCalls++, old.document);
  old.host.current = old.root;
  next.host.current = next.root;
  await Promise.resolve();
  assert.equal(oldCalls, 0);
  assert.equal(nextCalls, 1);
  stopNext();
});

test('foreign property ownership is never overwritten during cleanup', () => {
  const m = fixture();
  const stop = subscribeBabelEditorCommits(() => {}, m.document);
  const foreign = { child: m.editor, stateNode: m.host };
  const getter = () => foreign;
  Object.defineProperty(m.host, 'current', { configurable: true, get: getter });
  assert.throws(() => subscribeBabelEditorCommits(() => {}, m.document), /ownership/);
  stop();
  assert.equal(Object.getOwnPropertyDescriptor(m.host, 'current').get, getter);
  assert.equal(m.host.current, foreign);
});

test('missing root and unsupported native descriptors fail explicitly', () => {
  assert.throws(() => subscribeBabelEditorCommits(() => {}, { querySelectorAll() { return []; } }), /unavailable/);
  for (const descriptor of [{ configurable: false }, { writable: false }]) {
    const m = fixture();
    Object.defineProperty(m.host, 'current', descriptor);
    assert.throws(() => subscribeBabelEditorCommits(() => {}, m.document), /configurable writable/);
  }
  const m = fixture();
  Object.defineProperty(m.host, 'current', { configurable: true, get: () => m.root });
  assert.throws(() => subscribeBabelEditorCommits(() => {}, m.document), /data property/);
});
