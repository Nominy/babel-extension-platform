import test from 'node:test';
import assert from 'node:assert/strict';
import { readBabelPlaybackBindings, readBabelSessionState, readBabelTranscriptBindings, readBabelTurnIdentity, createBabelRowIdentityIndex } from '../src/index.mjs';

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
  const transcript = fiber({ turns: annotations, editingId: null,
    handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} } }, slate);
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
  const seed = { __reactFiber$native: editor, isConnected: true };
  let mounted = true;
  const document = { querySelectorAll(selector) {
    counters.selectors.push(selector);
    return mounted ? [seed] : [];
  } };
  return { counters, fiber, wave, registry, panel, transcript, slate, toolbar, select, editor, root, host, document, seed, seeks,
    setMounted(value) { mounted = seed.isConnected = value; },
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

test('successful connected root seeds avoid DOM rediscovery while every reader follows current committed data', () => {
  const model = fixture();
  assert.equal(readBabelSessionState(model.document).reviewActionId, 'task-a');
  model.resetCounters();
  for (let frame = 0; frame < 100; frame++) {
    assert.equal(readBabelSessionState(model.document).reviewActionId, 'task-a');
    assert.equal(readBabelTurnIdentity('turn', model.document).reviewActionId, 'task-a');
    assert.equal(readBabelPlaybackBindings(model.document).waves.length, 2);
  }
  assert.equal(model.counters.selectors.length, 0, 'warm readers never scan the transcript DOM for root seeds');
  model.editor.props.reviewActionId = 'same-pointer-task';
  model.transcript.props.readOnly = true;
  assert.deepEqual(readBabelSessionState(model.document), { reviewActionId: 'same-pointer-task', readOnly: true });
  const transcript = model.fiber({ ...model.transcript.props, readOnly: false });
  const panel = model.fiber({ ...model.panel.props, annotations: [{ id: 'turn', startTimeInSeconds: 9 }] }, transcript);
  const editor = model.fiber({ ...model.editor.props, reviewActionId: 'alternate-task' }, panel);
  const root = model.fiber({}, editor);
  root.alternate = model.root;
  root.stateNode = model.host;
  editor.alternate = model.editor;
  model.host.current = root;
  assert.deepEqual(readBabelSessionState(model.document), { reviewActionId: 'alternate-task', readOnly: false });
  assert.equal(readBabelTurnIdentity('turn', model.document).startSeconds, 9);
  assert.equal(model.counters.selectors.length, 0, 'a committed alternate does not require DOM rediscovery');
});

test('cached root seeds follow same-surface root replacement, reject detached nodes and rediscover after reappearance', () => {
  const model = fixture(), replacement = fixture();
  readBabelSessionState(model.document);
  model.resetCounters();
  replacement.editor.props.reviewActionId = 'replacement-task';
  model.seed.__reactFiber$native = replacement.editor;
  model.editor.props.reviewActionId = 'stale-task';
  assert.equal(readBabelSessionState(model.document).reviewActionId, 'replacement-task');
  assert.equal(model.counters.selectors.length, 0, 'same connected surface follows its new native root directly');
  model.setMounted(false);
  assert.equal(readBabelSessionState(model.document), null, 'a detached successful seed is never authority');
  model.resetCounters();
  model.setMounted(true);
  assert.equal(readBabelSessionState(model.document).reviewActionId, 'replacement-task');
  assert.equal(model.counters.selectors.length, 1, 'reappearance performs one successful discovery');
  model.resetCounters();
  delete model.seed.__reactFiber$native;
  model.seed.__reactFiber$newRenderer = replacement.editor;
  assert.equal(readBabelSessionState(model.document).reviewActionId, 'replacement-task');
  assert.equal(model.counters.selectors.length, 1, 'changed renderer keys invalidate the cached location');
  model.resetCounters();
  assert.equal(readBabelSessionState(model.document).reviewActionId, 'replacement-task');
  assert.equal(model.counters.selectors.length, 0);
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

test('wave track identity follows registry keys rather than recording order or reused wave objects', () => {
  const model = fixture();
  model.editor.props.transcriptionChunkProcessedRecordings = [
    { processedRecordingId: 'b', speaker: 2 }, { processedRecordingId: 'a', speaker: 1 }
  ];
  const original = readBabelPlaybackBindings(model.document);
  assert.deepEqual(original.waveTracks, [
    { trackId: 'a', wave: model.registry.a.wavesurfer },
    { trackId: 'b', wave: model.registry.b.wavesurfer }
  ]);
  const entry = model.registry.b;
  delete model.registry.b;
  model.registry.reassigned = entry;
  assert.equal(original.isCurrent(), false, 'same wave under a different track invalidates an old binding');
  const current = readBabelPlaybackBindings(model.document);
  assert.equal(current.waveTracks[1].trackId, 'reassigned');
  assert.equal(current.waveTracks[1].wave, entry.wavesurfer);
  assert.equal(original.waveTracks[1].trackId, 'b', 'published identity is not mutated');
  delete model.registry.a;
  assert.deepEqual(readBabelPlaybackBindings(model.document).waveTracks, [
    { trackId: 'reassigned', wave: entry.wavesurfer }
  ], 'late/removed lanes never shift a wave onto a different recording');
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
    trackLabel: 'Speaker 1', startSeconds: 1, endSeconds: 2, isActive: true, isEditing: false, readOnly: false
  });
  annotation.startTimeInSeconds = 3;
  annotation.endTimeInSeconds = 5;
  annotation.processedRecordingId = 'b';
  model.panel.props.tracks[1].label = 'Updated speaker';
  model.transcript.props.activeIds.delete('turn');
  model.transcript.props.editingId = 'turn';
  model.transcript.props.turns = [];
  model.editor.props.reviewActionId = 'task-b';
  assert.deepEqual(readBabelTurnIdentity('turn', model.document), {
    reviewActionId: 'task-b', annotationId: 'turn', processedRecordingId: 'b',
    trackLabel: 'Updated speaker', startSeconds: 3, endSeconds: 5, isActive: false, isEditing: true, readOnly: false
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
    trackLabel: '', startSeconds: 7, endSeconds: null, isActive: false, isEditing: false, readOnly: true
  });
  panel.child = null;
  assert.equal(readBabelTurnIdentity('turn', model.document), null);
  panel.child = transcript;
  model.setMounted(false);
  assert.equal(readBabelTurnIdentity('turn', model.document), null);
});

test('committed row revisions ignore playback-only props and keep active/editing state independent', () => {
  const model = fixture();
  const index = createBabelRowIdentityIndex(model.document);
  Object.assign(model.panel.props.annotations[0], { startTimeInSeconds: 1, endTimeInSeconds: 3, processedRecordingId: 'a' });
  const initial = index.reconcile();
  model.resetCounters();
  for (let tick = 0; tick < 20; tick++) {
    model.panel.props = { ...model.panel.props, currentTime: tick, tracks: model.panel.props.tracks.slice() };
    model.editor.props = { ...model.editor.props, currentTime: tick };
    model.transcript.props.activeIds = new Set(tick % 2 ? ['turn'] : []);
    model.transcript.props.editingId = tick % 2 ? 'turn' : null;
    const root = model.fiber({}, model.editor);
    root.stateNode = model.host;
    root.alternate = model.host.current;
    model.host.current = root;
    const next = index.reconcile(true);
    assert.equal(next.revision, initial.revision);
    assert.equal(next.identities, initial.identities);
    assert.deepEqual(next.activeIds, tick % 2 ? ['turn'] : []);
    assert.equal(next.editingId, tick % 2 ? 'turn' : null);
  }
  assert.equal(model.counters.text, 0, 'playback-only commits do not inspect unchanged annotation content');
  model.panel.props.annotations = model.panel.props.annotations.slice();
  assert.equal(index.reconcile(true).revision, initial.revision, 'equivalent canonical arrays do not publish a false edit');
  index.dispose();
});

test('row revisions reconcile native in-place commits, canonical filters, task replacement and disposal', () => {
  const model = fixture(), index = createBabelRowIdentityIndex(model.document);
  model.panel.props.annotations = [
    { id: 'one', startTimeInSeconds: 1, endTimeInSeconds: 3, processedRecordingId: 'a', content: 'one' },
    { id: 'two', startTimeInSeconds: 4, endTimeInSeconds: 6, processedRecordingId: 'b', content: 'two' }
  ];
  model.panel.props.tracks = [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }];
  const initial = index.reconcile();
  model.panel.props.annotations[0].startTimeInSeconds = 2;
  model.panel.props.tracks[0].label = 'Renamed';
  const edited = index.reconcile(true);
  assert.ok(edited.revision > initial.revision);
  assert.equal(edited.identities[0].startSeconds, 2);
  assert.equal(edited.identities[0].trackLabel, 'Renamed');
  assert.equal(initial.identities[0].startSeconds, 1, 'old presentations cannot change under consumers');
  model.transcript.props.turns = [];
  const filtered = index.reconcile(true);
  assert.equal(filtered.revision, edited.revision);
  assert.equal(filtered.identities.length, 2, 'canonical annotations are not replaced by the filtered transcript');
  model.panel.props.annotations.reverse();
  const reordered = index.reconcile(true);
  assert.equal(reordered.identities[0].annotationId, 'two');
  model.editor.props.reviewActionId = 'task-b';
  const replaced = index.reconcile(true);
  assert.ok(replaced.identities.every(identity => identity.reviewActionId === 'task-b'));
  assert.ok(replaced.revision > reordered.revision);
  model.setMounted(false);
  assert.equal(index.reconcile(true), null);
  model.setMounted(true);
  assert.equal(index.reconcile().identities[0].reviewActionId, 'task-b');
  index.dispose();
  model.panel.props.annotations[0].content = 'edited after dispose';
  assert.ok(index.reconcile().revision > replaced.revision, 'disposed indexes retain no old annotation snapshots');
});

test('playback lifetime predicate validates live refs and small recording metadata without transcript traversal', () => {
  const model = fixture();
  model.editor.props.transcriptionChunkProcessedRecordings = [
    { processedRecordingId: 'recording-a', speaker: 1 },
    { processedRecordingId: 'recording-b', speaker: 2 }
  ];
  const binding = readBabelPlaybackBindings(model.document);
  assert.deepEqual(binding.recordingTracks, [
    { id: 'recording-a', label: 'Speaker 1' }, { id: 'recording-b', label: 'Speaker 2' }
  ]);
  model.resetCounters();
  for (let index = 0; index < 100; index++) assert.equal(binding.isCurrent(), true);
  assert.equal(model.counters.text, 0);
  assert.ok(model.counters.props < 1200, `lifetime checks visited ${model.counters.props} props`);
  model.editor.props.transcriptionChunkProcessedRecordings =
    model.editor.props.transcriptionChunkProcessedRecordings.map(recording => ({ ...recording }));
  assert.equal(binding.isCurrent(), true, 'equal recording props do not invalidate metadata');
  model.editor.props.transcriptionChunkProcessedRecordings[1].speaker = 3;
  assert.equal(binding.isCurrent(), false, 'in-place label changes invalidate metadata');
  const updated = readBabelPlaybackBindings(model.document);
  assert.equal(updated.recordingTracks[1].label, 'Speaker 3');
  model.registry.a.wavesurfer = model.wave(4);
  assert.equal(updated.isCurrent(), false, 'live refs, not a retained task identity, authorize notifications');
  const replacement = readBabelPlaybackBindings(model.document);
  model.editor.props.reviewActionId = 'task-new';
  assert.equal(replacement.isCurrent(), false);
});
