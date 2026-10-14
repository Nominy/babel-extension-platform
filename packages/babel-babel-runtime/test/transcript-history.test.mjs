import test from 'node:test';
import assert from 'node:assert/strict';
import { readBabelTranscriptBindings } from '../src/index.mjs';

function nativeHistoryFixture() {
  const annotations = [{ id: 'turn', type: 'transcription', content: 'Committed text' }];
  const first = { do() {}, undo() {} };
  const committed = { undoStack: [first], redoStack: [], undo() {}, redo() {}, executeAndPush() {} };
  let live = committed;
  const historyHook = { memoizedState: committed, queue: { getSnapshot: () => live } };
  const transcript = { memoizedProps: { turns: annotations, handlers: { onChangeText() {} } } };
  const panel = { memoizedProps: { annotations, tracks: [], saveState: {}, renderTranscript() {}, onSave() {} },
    memoizedState: historyHook, child: transcript };
  const workbench = { memoizedProps: { reviewActionId: 'native-task', transcriptionChunkProcessedRecordings: [] }, child: panel };
  const root = { child: workbench };
  root.stateNode = { current: root };
  workbench.return = root;
  panel.return = workbench;
  transcript.return = panel;
  const seed = { __reactFiber$native: workbench };
  const document = { querySelectorAll: () => [seed] };
  return { annotations, committed, historyHook, workbench, root, document, setLive(value) { live = value; } };
}

test('history reads the synchronous native store while transcript annotations retain committed identity', () => {
  const fixture = nativeHistoryFixture();
  const initial = readBabelTranscriptBindings(fixture.document);
  assert.equal(initial.history, fixture.committed);
  const command = { do() {}, undo() {} };
  const live = { ...fixture.committed, undoStack: [...fixture.committed.undoStack, command] };
  fixture.setLive(live);
  const binding = readBabelTranscriptBindings(fixture.document);
  assert.equal(binding.history, live);
  assert.equal(binding.history.undoStack.at(-1), command);
  assert.equal(fixture.historyHook.memoizedState, fixture.committed, 'React has not committed the store update yet');
  assert.equal(binding.annotations, fixture.annotations);
  assert.deepEqual(Object.keys(binding.pendingTextById), []);
});

test('history fails closed for missing, throwing, malformed or different native store getters', () => {
  const fixture = nativeHistoryFixture();
  const invalid = [null, {}, { ...fixture.committed, undoStack: null },
    { ...fixture.committed, undo() {} }, { ...fixture.committed, redo() {} },
    { ...fixture.committed, executeAndPush() {} }];
  for (const value of invalid) {
    fixture.setLive(value);
    const binding = readBabelTranscriptBindings(fixture.document);
    assert.equal(binding.history, null);
    assert.equal(binding.annotations, fixture.annotations);
  }
  fixture.historyHook.queue.getSnapshot = () => { throw new Error('Store unmounted'); };
  assert.equal(readBabelTranscriptBindings(fixture.document).history, null);
  delete fixture.historyHook.queue;
  assert.equal(readBabelTranscriptBindings(fixture.document).history, null, 'committed stale history is not a fallback');
});

test('current native controller needs operations, not a private annotations ref', () => {
  const fixture = nativeHistoryFixture();
  const controller = {
    selectTurn() {}, updateTime() {}, updateText() {}, split() {}, remove() {}, toggleWarningAssertion() {},
  };
  const rpc = new Proxy({}, { get: () => () => { throw new Error('Not a native controller'); } });
  fixture.workbench.memoizedState = { memoizedState: [rpc, []],
    next: { memoizedState: [controller, []] } };
  assert.equal(readBabelTranscriptBindings(fixture.document).controller, controller);
  const replacement = { ...controller, split() {} };
  const current = { ...fixture.workbench, memoizedState: { memoizedState: [replacement, []] } };
  fixture.root.child = current;
  assert.equal(readBabelTranscriptBindings(fixture.document).controller, replacement,
    'a committed replacement must not reuse the previous controller');
  current.memoizedState.memoizedState = [{ ...replacement, split: null }, []];
  assert.equal(readBabelTranscriptBindings(fixture.document).controller, null);
});
