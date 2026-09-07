import test from 'node:test';
import assert from 'node:assert/strict';
import { readBabelEditorState } from '../src/index.mjs';

test('reads recording identity without annotations or waveform instances and follows committed root', () => {
  const props = {
    reviewActionId: 'task-a', mode: 'transcription',
    transcriptionChunkProcessedRecordings: [
      { processedRecordingId: 'a', processedRecordingUrl: 'a.wav', speaker: 1 },
      { processedRecordingId: 'b', processedRecordingUrl: 'b.wav', speaker: null }
    ]
  };
  const root = { child: { memoizedProps: props } };
  const state = { current: root };
  root.stateNode = state;
  const documentRef = { querySelectorAll: () => [{ __reactFiber$test: { return: root } }] };
  assert.deepEqual(readBabelEditorState(documentRef), {
    reviewActionId: 'task-a', tracks: [
      { id: 'a', label: 'Speaker 1', audioUrl: 'a.wav' },
      { id: 'b', label: 'Track 2', audioUrl: 'b.wav' }
    ]
  });
  state.current = { child: { memoizedProps: { ...props, reviewActionId: 'task-b', mode: 'annotation' } } };
  assert.equal(readBabelEditorState(documentRef).reviewActionId, 'task-b');
  assert.deepEqual(readBabelEditorState(documentRef).tracks.map(track => track.label), ['Recording 1', 'Recording 2']);
  state.current = {};
  assert.equal(readBabelEditorState(documentRef), null);
});
