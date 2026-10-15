import test from 'node:test';
import assert from 'node:assert/strict';
import { readBabelTranscriptBindings } from '../src/index.mjs';

function nativeHistoryFixture() {
  const annotations = [{ id: 'turn', type: 'transcription', content: 'Committed text' }];
  const first = { do() {}, undo() {} };
  const committed = { undoStack: [first], redoStack: [], undo() {}, redo() {}, executeAndPush() {} };
  let live = committed;
  const historyHook = { memoizedState: committed, queue: { getSnapshot: () => live } };
  const transcript = { memoizedProps: { turns: annotations, editingId: null, localEdits: false,
    handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} } } };
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
  return { annotations, committed, historyHook, transcript, panel, workbench, root, document, setLive(value) { live = value; } };
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
    editTurn() {}, leaveTurn() {}, selectTurn() {}, seekTurn() {},
    updateTime() {}, updateText() {}, split() {}, remove() {}, toggleWarningAssertion() {},
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

test('Oct15 editing ownership and local Slate history stay native while global history advances', () => {
  const fixture = nativeHistoryFixture();
  const transcript = fixture.transcript.memoizedProps;
  const local = { undos: [{ operations: ['insert_text'] }], redos: [] };
  const cache = { restore() {}, save() {} };
  const slate = {
    children: [{ children: [{ text: 'Pending ' }, { type: 'tag', raw: '[laugh]', children: [{ text: '' }] }] }],
    history: local, apply() {}, insertData() {}
  };
  fixture.transcript.memoizedState = { memoizedState: cache };
  fixture.transcript.child = { memoizedProps: {
    turn: fixture.annotations[0], isActive: false, isEditing: true, history: cache
  }, child: { memoizedProps: { editor: slate } } };
  transcript.editingId = 'turn';
  transcript.localEdits = true;
  transcript.readOnly = true;
  const live = { ...fixture.committed, undoStack: [] };
  fixture.setLive(live);
  const binding = readBabelTranscriptBindings(fixture.document);
  assert.equal(binding.transcript, transcript);
  assert.equal(binding.transcript.editingId, 'turn');
  assert.equal(binding.readOnly, true, 'native local-only edits cannot authorize helper persistence');
  assert.equal(binding.history, live, 'global Undo must not resolve the row-local Slate cache');
  assert.equal(binding.pendingTextById.turn, 'Pending [laugh]');
  assert.equal(slate.history, local, 'reading pending text must never reset native local Undo');
  assert.equal(fixture.transcript.memoizedState.memoizedState, cache);
});

test('old activation-only transcripts cannot authorize current editing operations', () => {
  const fixture = nativeHistoryFixture();
  const transcript = fixture.transcript.memoizedProps;
  delete transcript.editingId;
  assert.equal(readBabelTranscriptBindings(fixture.document), null);
  transcript.editingId = null;
  const deactivate = transcript.handlers.onDeactivate;
  delete transcript.handlers.onDeactivate;
  assert.equal(readBabelTranscriptBindings(fixture.document), null);
  transcript.handlers.onDeactivate = deactivate;
  assert.equal(readBabelTranscriptBindings(fixture.document).transcript, transcript);
});

test('current transcript callbacks replace retired render closures without rewriting native props', () => {
  const fixture = nativeHistoryFixture();
  const calls = [];
  const previous = fixture.transcript.memoizedProps;
  previous.handlers.onChangeText = () => assert.fail('retired text writer');
  readBabelTranscriptBindings(fixture.document);
  const next = { ...previous, editingId: 'turn', handlers: {
    ...previous.handlers, onChangeText(id, text) { calls.push([id, text]); }
  } };
  fixture.transcript.memoizedProps = next;
  const binding = readBabelTranscriptBindings(fixture.document);
  binding.transcript.handlers.onChangeText('turn', 'Current text');
  assert.deepEqual(calls, [['turn', 'Current text']]);
  assert.equal(binding.transcript, next);
  assert.equal(fixture.transcript.memoizedProps.handlers, next.handlers);
});
