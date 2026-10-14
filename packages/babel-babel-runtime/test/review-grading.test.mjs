import test from 'node:test';
import assert from 'node:assert/strict';
import { gradingSnapshotKey } from '../src/review-grading.mjs';

const state = () => ({ actionId: 'action', actionLevel: 2, annotations: [{
  id: 'turn', type: 'transcription', content: 'Текст.', processedRecordingId: 'speaker-1',
  startTimeInSeconds: 1, endTimeInSeconds: 2, intensity: null,
  metadata: { assertedWarnings: ['confirmed'], signal: { answer: 'approved', occurrenceStart: 0 } },
}] });

test('grading identity rejects changed annotation meaning even when words and times stay unchanged', () => {
  const original = state();
  for (const patch of [
    { type: 'background_noise' },
    { intensity: 2 },
    { metadata: { assertedWarnings: [], signal: { answer: 'approved', occurrenceStart: 0 } } },
    { metadata: { assertedWarnings: ['confirmed'], signal: { answer: 'rejected', occurrenceStart: 0 } } },
  ]) {
    const changed = state();
    Object.assign(changed.annotations[0], patch);
    assert.notEqual(gradingSnapshotKey(original, original), gradingSnapshotKey(original, changed));
  }
});

test('grading identity survives reordered metadata and capture timestamps', () => {
  const original = state();
  const refreshed = state();
  refreshed.capturedAt = 'later';
  refreshed.annotations[0].updatedAt = 'later';
  refreshed.annotations[0].metadata = { signal: { occurrenceStart: 0, answer: 'approved' }, assertedWarnings: ['confirmed'] };
  assert.equal(gradingSnapshotKey(original, original), gradingSnapshotKey(original, refreshed));
});
