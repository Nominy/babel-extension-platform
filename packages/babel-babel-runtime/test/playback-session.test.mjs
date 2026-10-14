import test from 'node:test';
import assert from 'node:assert/strict';
import { readBabelPlaybackBindings, readBabelSessionState, readBabelTranscriptBindings, readBabelTurnIdentity } from '../src/index.mjs';

function fixture() {
  const counters = { props: 0, text: 0, selectors: [] };
  const fiber = (props, child = null) => {
    const node = { props, child };
    Object.defineProperty(node, 'memoizedProps', {
      get() { counters.props++; return this.props; },
      set(value) { this.props = value; }
    });
    if (child) child.return = node;
    return node;
  };
  const wave = (time = 1) => ({ time, rate: 1, playing: false,
    getCurrentTime() { return this.time; }, getDuration() { return 30; },
    getPlaybackRate() { return this.rate; }, isPlaying() { return this.playing; }
  });
  const registry = { a: { wavesurfer: wave() }, b: { wavesurfer: wave() } };
  const annotations = [{ id: 'turn', type: 'transcription',
    get content() { counters.text++; return 'Committed'; } }];
  const slate = fiber({ turn: { id: 'turn' }, editor: {
    children: [{ children: [{ text: 'Pending' }] }], apply() {}, insertData() {}
  } });
  const transcript = fiber({ turns: annotations, handlers: { onChangeText() {} } }, slate);
  const seeks = [];
  const panel = fiber({ annotations, tracks: [], saveState: {}, renderTranscript() {}, onSave() {},
    onPlayPause() { for (const entry of Object.values(registry)) entry.wavesurfer.playing = !entry.wavesurfer.playing; },
    onSeekToAnnotation(annotation) {
      seeks.push(annotation);
      for (const entry of Object.values(registry)) entry.wavesurfer.time = annotation.startTimeInSeconds;
    }
  }, transcript);
  const select = fiber({ value: '1', onValueChange(value) {
    for (const entry of Object.values(registry)) entry.wavesurfer.rate = Number(value);
  } });
  const toolbar = fiber({ reviewActionId: 'task-a', onSpeedChange() {} }, select);
  panel.sibling = toolbar;
  let decoy = null;
  for (let index = 0; index < 1000; index++) decoy = fiber({}, decoy);
  decoy.sibling = panel;
  const editor = fiber({ reviewActionId: 'task-a', transcriptionChunkProcessedRecordings: [] }, decoy);
  panel.return = toolbar.return = editor;
  editor.memoizedState = { memoizedState: { current: registry } };
  const root = fiber({}, editor);
  const host = { current: root };
  root.stateNode = host;
  const seed = { __reactFiber$native: editor };
  let mounted = true;
  const document = { querySelectorAll(selector) {
    counters.selectors.push(selector);
    return mounted ? [seed] : [];
  } };
  return { counters, fiber, wave, registry, panel, transcript, slate, toolbar, select, editor, root, host, document, seeks,
    setMounted(value) { mounted = value; },
    resetCounters() { counters.props = counters.text = 0; counters.selectors.length = 0; }
  };
}

test('warm session and playback reads avoid transcript traversal and text materialization', () => {
  const model = fixture();
  const full = readBabelTranscriptBindings(model.document);
  assert.equal(full.pendingTextById.turn, 'Pending');
  assert.ok(model.counters.props > 1000);
  assert.ok(model.counters.text > 0);
  const initial = readBabelPlaybackBindings(model.document);
  model.resetCounters();
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(readBabelSessionState(model.document), { reviewActionId: 'task-a', readOnly: false });
    const playback = readBabelPlaybackBindings(model.document);
    assert.equal(playback.waves, initial.waves, 'unchanged refs do not allocate a new wave array');
    model.registry.a.wavesurfer.time = index;
    assert.equal(playback.waves[0].getCurrentTime(), index, 'no playback clock is cached');
  }
  assert.equal(model.counters.text, 0);
  assert.ok(model.counters.props < 2000, `warm reads visited ${model.counters.props} props`);
  assert.ok(model.counters.selectors.every(selector => !selector.includes('section')));
});

test('session permissions follow every authority even with unchanged task and Fiber identities', () => {
  const model = fixture();
  assert.equal(readBabelSessionState(model.document).readOnly, false);
  for (const authority of [model.editor, model.panel, model.transcript]) {
    authority.props = { ...authority.props, readOnly: true };
    assert.equal(readBabelSessionState(model.document).readOnly, true);
    authority.props = { ...authority.props, readOnly: false };
    assert.equal(readBabelSessionState(model.document).readOnly, false);
  }
  model.transcript.props = {};
  assert.equal(readBabelSessionState(model.document), null, 'removed transcript cannot authorize access');
});

test('committed alternates, relocated descendants and same-task remounts invalidate locations', () => {
  const model = fixture();
  readBabelSessionState(model.document);
  readBabelPlaybackBindings(model.document);
  const transcript = model.fiber({ ...model.transcript.props, readOnly: true });
  const panel = model.fiber({ ...model.panel.props }, model.fiber({}, transcript));
  const editor = model.fiber({ ...model.editor.props, reviewActionId: 'task-b' }, panel);
  const root = model.fiber({}, editor);
  root.alternate = model.root;
  editor.alternate = model.editor;
  model.host.current = root;
  assert.deepEqual(readBabelSessionState(model.document), { reviewActionId: 'task-b', readOnly: true });
  transcript.props = { ...transcript.props, readOnly: false };
  assert.equal(readBabelSessionState(model.document).readOnly, false);
  const replacement = model.fiber({ ...panel.props, readOnly: true }, transcript);
  editor.child = replacement;
  assert.equal(readBabelSessionState(model.document).readOnly, true, 'same-task panel replacement is read immediately');
  model.host.current = model.fiber({});
  assert.equal(readBabelSessionState(model.document), null);
  assert.equal(readBabelPlaybackBindings(model.document), null);
  model.host.current = root;
  model.setMounted(false);
  assert.equal(readBabelSessionState(model.document), null, 'detached DOM never reuses a remembered root');
});

test('wave membership reuse detects replacement, removal, reorder and late mounting in place', () => {
  const model = fixture();
  const original = readBabelPlaybackBindings(model.document);
  const replacement = model.wave(9);
  model.registry.a.wavesurfer = replacement;
  let current = readBabelPlaybackBindings(model.document);
  assert.notEqual(current.waves, original.waves);
  assert.equal(current.waves[0], replacement);
  assert.notEqual(original.waves[0], replacement, 'published binding retains its own source identity');
  const a = model.registry.a;
  delete model.registry.a;
  model.registry.a = a;
  current = readBabelPlaybackBindings(model.document);
  assert.deepEqual(current.waves, [model.registry.b.wavesurfer, replacement]);
  delete model.registry.b;
  assert.deepEqual(readBabelPlaybackBindings(model.document).waves, [replacement]);
  delete model.registry.a;
  assert.deepEqual(readBabelPlaybackBindings(model.document).waves, []);
  model.registry.c = { wavesurfer: model.wave(4) };
  assert.deepEqual(readBabelPlaybackBindings(model.document).waves, [model.registry.c.wavesurfer]);
  model.registry.c.wavesurfer = null;
  assert.deepEqual(readBabelPlaybackBindings(model.document).waves, [], 'invalid registries do not replay old sources');
});

test('native seek resolves current same-task callbacks but rejects superseded task commands', () => {
  const model = fixture();
  const playback = readBabelPlaybackBindings(model.document);
  playback.seekToTime(3);
  assert.deepEqual(model.seeks, [{ startTimeInSeconds: 3, processedRecordingId: null }]);
  assert.equal(playback.waves[1].getCurrentTime(), 3);
  const calls = [];
  model.panel.props = { ...model.panel.props, onSeekToAnnotation(value) { calls.push(value); } };
  playback.seekToTime(4);
  assert.deepEqual(calls, [{ startTimeInSeconds: 4, processedRecordingId: null }]);
  assert.equal(model.seeks.length, 1);
  model.editor.props = { ...model.editor.props, reviewActionId: 'task-b' };
  playback.seekToTime(5);
  assert.equal(calls.length, 1);
  assert.equal(readBabelPlaybackBindings(model.document).setSpeed, null, 'old task toolbar does not authorize speed changes');
  model.panel.props = {};
  assert.equal(readBabelPlaybackBindings(model.document).seekToTime, null);
});

test('native playback toggle and speed actions stay wired to current source refs', () => {
  const model = fixture();
  let playback = readBabelPlaybackBindings(model.document);
  playback.togglePlayPause();
  assert.ok(playback.waves.every(wave => wave.isPlaying()));
  playback.setSpeed('1.5');
  assert.ok(playback.waves.every(wave => wave.getPlaybackRate() === 1.5));
  const select = model.fiber({ value: '1.5', onValueChange: value => { model.select.props.last = value; } });
  model.toolbar.child = model.fiber({}, select);
  playback = readBabelPlaybackBindings(model.document);
  playback.setSpeed('2');
  assert.equal(model.select.props.last, '2');
});

test('turn identity reads current timing, track, active selection and all permission authorities without Slate', () => {
  const model = fixture();
  const annotation = model.panel.props.annotations[0];
  Object.assign(annotation, { processedRecordingId: 'a', startTimeInSeconds: 1, endTimeInSeconds: 2 });
  model.panel.props.tracks = [{ id: 'a', label: 'Speaker 1' }, { id: 'b', label: 'Speaker 2' }];
  model.transcript.props.activeIds = new Set(['turn']);
  Object.defineProperty(model.slate, 'props', { get() { assert.fail('Identity must not read the Slate Fiber'); } });
  Object.defineProperty(model.editor, 'memoizedState', { get() { assert.fail('Identity must not read editor hooks'); } });
  Object.defineProperty(model.panel, 'memoizedState', { get() { assert.fail('Identity must not read native history'); } });
  assert.deepEqual(readBabelTurnIdentity('turn', model.document), {
    reviewActionId: 'task-a', annotationId: 'turn', processedRecordingId: 'a',
    trackLabel: 'Speaker 1', startSeconds: 1, endSeconds: 2, isActive: true, readOnly: false
  });
  annotation.startTimeInSeconds = 3;
  annotation.endTimeInSeconds = 5;
  annotation.processedRecordingId = 'b';
  model.panel.props.tracks[1].label = 'Updated speaker';
  model.transcript.props.activeIds.delete('turn');
  model.transcript.props.turns = [];
  model.editor.props.reviewActionId = 'task-b';
  assert.deepEqual(readBabelTurnIdentity('turn', model.document), {
    reviewActionId: 'task-b', annotationId: 'turn', processedRecordingId: 'b',
    trackLabel: 'Updated speaker', startSeconds: 3, endSeconds: 5, isActive: false, readOnly: false
  }, 'filtered turns do not replace canonical annotation metadata');
  for (const authority of [model.editor, model.panel, model.transcript]) {
    authority.props.readOnly = true;
    assert.equal(readBabelTurnIdentity('turn', model.document).readOnly, true);
    authority.props.readOnly = false;
    assert.equal(readBabelTurnIdentity('turn', model.document).readOnly, false);
  }
  assert.equal(model.counters.text, 0);
});

test('turn index validates mutable membership and reads replacement objects instead of retained rows', () => {
  const model = fixture();
  const annotations = [
    { id: 'a', startTimeInSeconds: 1 }, { id: 'b', startTimeInSeconds: 2 }, { id: 'c', startTimeInSeconds: 3 }
  ];
  model.panel.props.annotations = annotations;
  assert.equal(readBabelTurnIdentity('b', model.document).startSeconds, 2);
  annotations[1] = { id: 'b', startTimeInSeconds: 20 };
  assert.equal(readBabelTurnIdentity('b', model.document).startSeconds, 20);
  annotations.reverse();
  assert.equal(readBabelTurnIdentity('a', model.document).startSeconds, 1);
  annotations.splice(1, 1);
  assert.equal(readBabelTurnIdentity('b', model.document), null);
  assert.equal(readBabelTurnIdentity('a', model.document).startSeconds, 1);
  annotations[1].id = 'renamed';
  assert.equal(readBabelTurnIdentity('a', model.document), null);
  assert.equal(readBabelTurnIdentity('renamed', model.document).startSeconds, 1);
  assert.equal(readBabelTurnIdentity('late', model.document), null);
  annotations.push({ id: 'late', startTimeInSeconds: 30 });
  assert.equal(readBabelTurnIdentity('late', model.document).startSeconds, 30, 'misses do not cache absence');
  model.panel.props.annotations = [{ id: 'late', startTimeInSeconds: 40 }];
  assert.equal(readBabelTurnIdentity('late', model.document).startSeconds, 40);
  assert.equal(readBabelTurnIdentity('renamed', model.document), null);
  model.panel.props.annotations.length = 0;
  assert.equal(readBabelTurnIdentity('late', model.document), null);
});

test('a full row identity signature validates each requested slot without quadratic annotation searches', () => {
  const model = fixture();
  let idReads = 0;
  const annotations = Array.from({ length: 1000 }, (_, index) => ({
    get id() { idReads++; return `turn-${index}`; },
    get content() { assert.fail('Identity must not serialize annotation content'); },
    startTimeInSeconds: index, endTimeInSeconds: index + 1
  }));
  model.panel.props.annotations = annotations;
  readBabelTurnIdentity('turn-0', model.document);
  model.resetCounters();
  idReads = 0;
  for (let index = 0; index < annotations.length; index++) {
    const identity = readBabelTurnIdentity(`turn-${index}`, model.document);
    assert.equal(identity.startSeconds, index);
    assert.equal(identity.endSeconds, index + 1);
  }
  assert.equal(idReads, 1000, 'one current-slot ID validation per row, not a scan of all IDs');
  assert.ok(model.counters.props < 10000, `read ${model.counters.props} Fiber props for 1000 identities`);
  assert.equal(model.counters.text, 0);
  assert.ok(model.counters.selectors.every(selector => !selector.includes('section')));
});

test('turn identity follows committed remounts and fails closed when native authority disappears', () => {
  const model = fixture();
  readBabelTurnIdentity('turn', model.document);
  const transcript = model.fiber({ ...model.transcript.props, readOnly: true });
  const panel = model.fiber({ ...model.panel.props, annotations: [{ id: 'turn', startTimeInSeconds: 7 }] }, transcript);
  const editor = model.fiber({ ...model.editor.props, reviewActionId: 'replacement-task' }, panel);
  const root = model.fiber({}, editor);
  root.alternate = model.root;
  editor.alternate = model.editor;
  model.host.current = root;
  assert.deepEqual(readBabelTurnIdentity('turn', model.document), {
    reviewActionId: 'replacement-task', annotationId: 'turn', processedRecordingId: null,
    trackLabel: '', startSeconds: 7, endSeconds: null, isActive: false, readOnly: true
  });
  panel.child = null;
  assert.equal(readBabelTurnIdentity('turn', model.document), null);
  panel.child = transcript;
  model.setMounted(false);
  assert.equal(readBabelTurnIdentity('turn', model.document), null);
});
