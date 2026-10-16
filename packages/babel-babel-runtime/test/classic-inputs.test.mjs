import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBabelClassicInput, readBabelClassicInput, flushBabelClassicInputs, readBabelTranscriptBindings } from '../src/index.mjs';

function fixture() {
  const annotation = { id: 'turn', type: 'transcription', content: 'saved', processedRecordingId: 'recording',
    startTimeInSeconds: 1, endTimeInSeconds: 4, updatedAt: 'original' };
  const calls = [], history = { undoStack: [], redoStack: [], undo() {}, redo() {}, executeAndPush() {} };
  const handlers = { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText(id, text) { calls.push([id, text]); } };
  const transcript = { memoizedProps: { turns: [annotation], editingId: 'turn', handlers } };
  const panel = { memoizedProps: { annotations: [annotation], saveState: {}, renderTranscript() {}, onSave() {} },
    memoizedState: { memoizedState: history, queue: { getSnapshot: () => history } }, child: transcript };
  const controller = { editTurn() {}, leaveTurn() {}, selectTurn() {}, seekTurn() {}, updateTime() {},
    updateText() {}, split() {}, remove() {}, toggleWarningAssertion() {} };
  const workbench = { memoizedProps: { reviewActionId: 'task', transcriptionChunkProcessedRecordings: [] },
    memoizedState: { memoizedState: [controller] }, child: panel };
  const root = { child: workbench }; root.stateNode = { current: root };
  const document = { querySelectorAll: () => [{ __reactFiber$classic: workbench }] };
  const row = { ownerDocument: document, isConnected: true, getAttribute: name =>
    name === 'data-annotation-id' ? 'turn' : name === 'data-babel-classic-row' ? 'true' : null };
  const rowHost = { memoizedProps: { turn: annotation, handlers }, child: { stateNode: row } };
  transcript.child = rowHost;
  workbench.return = root; panel.return = workbench; transcript.return = panel;
  rowHost.return = transcript; rowHost.child.return = rowHost;
  let text = 'pending', composing = false;
  const input = { annotation, reviewActionId: 'task', handlers, readOnly: false,
    read: () => ({ text, start: 1, end: 4, direction: 'backward', composing }),
    flush() { handlers.onChangeText(annotation.id, text); return true; } };
  const unregister = registerBabelClassicInput(row, input);
  return { annotation, calls, history, controller, transcript, panel, workbench, root, document, row, rowHost, input,
    unregister, setText(value) { text = value; }, setComposing(value) { composing = value; } };
}

test('Classic drafts preserve native transcript, current controller and global history identity', () => {
  const f = fixture();
  const bindings = readBabelTranscriptBindings(f.document);
  assert.equal(bindings.transcript, f.transcript.memoizedProps);
  assert.equal(bindings.panel, f.panel.memoizedProps);
  assert.equal(bindings.controller, f.controller);
  assert.equal(bindings.history, f.history);
  assert.equal(bindings.annotations[0], f.annotation);
  assert.equal(bindings.pendingTextById.turn, 'pending');
  const owned = readBabelClassicInput('turn', f.document);
  assert.equal(owned.row, f.row);
  assert.equal(owned.input, f.input);
  assert.deepEqual(owned.input.read(), { text: 'pending', start: 1, end: 4, direction: 'backward', composing: false });
  assert.equal(f.annotation.updatedAt, 'original', 'reads do not mutate native timestamp ownership');
  assert.deepEqual(f.calls, []);
});

test('document Symbol registry is visible across independently loaded MAIN bundles', async () => {
  const f = fixture();
  const separate = await import('../src/index.mjs?classic-input-second-main-bundle');
  assert.equal(separate.readBabelClassicInput('turn', f.document).input, f.input);
  f.unregister();
  assert.equal(separate.readBabelClassicInput('turn', f.document), null);
});

test('same task is insufficient: committed owner, row, recording, timing and source must match', () => {
  for (const mutate of [
    f => { f.workbench.memoizedProps.reviewActionId = 'other'; },
    f => { f.row.isConnected = false; },
    f => { f.transcript.child = { ...f.rowHost, child: null }; },
    f => { f.rowHost.memoizedProps = { ...f.rowHost.memoizedProps, handlers: {} }; },
    f => { f.transcript.memoizedProps.handlers = { ...f.input.handlers }; },
    f => { f.panel.memoizedProps.annotations = [{ ...f.annotation, processedRecordingId: 'other' }]; },
    f => { f.panel.memoizedProps.annotations = [{ ...f.annotation, startTimeInSeconds: 2 }]; },
    f => { f.panel.memoizedProps.annotations = [{ ...f.annotation, content: 'external change' }]; }
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(readBabelClassicInput('turn', f.document), null);
    assert.equal(flushBabelClassicInputs(f.document), false);
    assert.deepEqual(f.calls, []);
  }
});

test('readonly and composition retain pending text without authorizing save flushing', () => {
  const f = fixture();
  f.panel.memoizedProps.readOnly = true;
  assert.equal(readBabelClassicInput('turn', f.document).readOnly, true);
  assert.equal(readBabelTranscriptBindings(f.document).pendingTextById.turn, 'pending');
  assert.equal(flushBabelClassicInputs(f.document), false);
  f.panel.memoizedProps.readOnly = false;
  f.setComposing(true);
  assert.equal(flushBabelClassicInputs(f.document), false);
  f.setComposing(false);
  assert.equal(flushBabelClassicInputs(f.document), true);
  assert.deepEqual(f.calls, [['turn', 'pending']]);
  f.setText('saved');
  assert.equal(flushBabelClassicInputs(f.document), true);
  assert.equal(f.calls.length, 1, 'committed text needs no extra history command');
});

test('old TTS plaintext paragraph serialization supersedes modern single-paragraph inference', () => {
  const f = fixture();
  const editor = { children: [{ children: [{ text: 'first' }] }, { children: [{ text: 'second' }] }],
    apply() {}, insertData() {} };
  f.rowHost.child.child = { memoizedProps: { editor } };
  f.setText('first\nsecond');
  assert.equal(readBabelTranscriptBindings(f.document).pendingTextById.turn, 'first\nsecond');
  assert.equal(f.annotation.content, 'saved');
});

test('a stale second row prevents partial multirow flush', () => {
  const f = fixture();
  const second = { ...f.annotation, id: 'second' };
  const row = { ownerDocument: f.document, isConnected: true, getAttribute: name =>
    name === 'data-annotation-id' ? second.id : name === 'data-babel-classic-row' ? 'true' : null };
  registerBabelClassicInput(row, { ...f.input, annotation: second, flush() { assert.fail('stale row writer'); } });
  assert.equal(flushBabelClassicInputs(f.document), false);
  assert.deepEqual(f.calls, []);
});

function largeFixture() {
  const f = fixture();
  let previous = f.rowHost, last = null;
  // Representative long task: each real row carries its own nested controls,
  // menus and decorations; both ends must remain accessible beyond 20k Fibers.
  for (let index = 0; index < 1200; index++) {
    const annotation = { ...f.annotation, id: `large-${index}`, startTimeInSeconds: index * 5,
      endTimeInSeconds: index * 5 + 4 };
    f.panel.memoizedProps.annotations.push(annotation);
    f.transcript.memoizedProps.turns.push(annotation);
    const row = { ownerDocument: f.document, isConnected: true, getAttribute: name =>
      name === 'data-annotation-id' ? annotation.id : name === 'data-babel-classic-row' ? 'true' : null };
    const host = { memoizedProps: { turn: annotation, handlers: f.input.handlers },
      return: f.transcript, child: { stateNode: row } };
    host.child.return = host;
    let parent = host.child;
    for (let depth = 0; depth < 24; depth++) {
      parent.child = { memoizedProps: {}, return: parent };
      parent = parent.child;
    }
    previous.sibling = host;
    previous = host;
    const input = { annotation, reviewActionId: 'task', handlers: f.input.handlers,
      readOnly: false, composing: false, text: index === 1199 ? 'last pending draft' : annotation.content,
      read() { return { text: this.text, start: 1, end: 2, direction: 'backward', composing: this.composing }; },
      flush() { f.calls.push([annotation.id, this.text]); return true; } };
    registerBabelClassicInput(row, input);
    last = { annotation, row, host, input };
  }
  return { ...f, last };
}

test('large Classic tasks retain owned drafts and native flush access at both ends', () => {
  const f = largeFixture();
  assert.equal(readBabelClassicInput('turn', f.document).input, f.input);
  assert.equal(readBabelClassicInput(f.last.annotation.id, f.document).input, f.last.input);
  const bindings = readBabelTranscriptBindings(f.document);
  assert.equal(bindings.pendingTextById.turn, 'pending');
  assert.equal(bindings.pendingTextById[f.last.annotation.id], 'last pending draft');
  assert.equal(flushBabelClassicInputs(f.document), true);
  assert.deepEqual(f.calls, [['turn', 'pending'], [f.last.annotation.id, 'last pending draft']]);
});

test('large-task bulk flush validates the last row before writing the first draft', () => {
  const f = largeFixture();
  f.last.input.readOnly = true;
  assert.equal(flushBabelClassicInputs(f.document), false);
  assert.deepEqual(f.calls, []);
  f.last.input.readOnly = false;
  f.last.input.composing = true;
  assert.equal(flushBabelClassicInputs(f.document), false);
  assert.deepEqual(f.calls, []);
  f.last.input.composing = false;
  f.panel.memoizedProps.annotations[f.panel.memoizedProps.annotations.length - 1] = {
    ...f.last.annotation, processedRecordingId: 'new recording'
  };
  assert.equal(flushBabelClassicInputs(f.document), false);
  assert.deepEqual(f.calls, []);
});

test('cached large-task row locations follow committed edges, not connected stale Fibers', () => {
  const f = largeFixture();
  const id = f.last.annotation.id;
  assert.equal(readBabelClassicInput(id, f.document).input, f.last.input);
  const previous = f.transcript.child;
  // Keep every old return pointer intact while the committed ancestry changes.
  f.transcript.child = { memoizedProps: {}, child: previous };
  assert.equal(readBabelClassicInput(id, f.document).input, f.last.input,
    'a relocated live row is rediscovered from the committed tree');
  f.transcript.child = { memoizedProps: { turn: f.last.annotation, handlers: f.input.handlers },
    child: { stateNode: { ...f.last.row } } };
  assert.equal(f.last.row.isConnected, true);
  assert.equal(readBabelClassicInput(id, f.document), null,
    'an old connected row and its unchanged return chain cannot authorize another committed DOM row');
  assert.equal(flushBabelClassicInputs(f.document), false);
  assert.deepEqual(f.calls, []);
});
