import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl } from '../src/index.mjs';

test('normalizeBaseUrl trims trailing slash', () => {
  assert.equal(normalizeBaseUrl(' https://reviewgen.ovh/// '), 'https://reviewgen.ovh');
});
