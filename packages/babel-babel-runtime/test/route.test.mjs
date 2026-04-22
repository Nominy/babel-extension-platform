import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBabelRoute } from '../src/index.mjs';

test('parseBabelRoute detects read only review view', () => {
  const route = parseBabelRoute('https://dashboard.babel.audio/transcription?reviewActionId=abc&displayFeedback=true');
  assert.equal(route.isTranscriptionRoute, true);
  assert.equal(route.isReadOnlyFeedbackRoute, true);
});
