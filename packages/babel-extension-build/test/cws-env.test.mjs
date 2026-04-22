import test from 'node:test';
import assert from 'node:assert/strict';
import { parseItemUrl } from '../src/index.mjs';

test('parseItemUrl extracts publisher and extension ids', () => {
  assert.deepEqual(parseItemUrl('https://chromewebstore.googleapis.com/v2/publishers/pub/items/ext'), {
    publisherId: 'pub',
    extensionId: 'ext'
  });
});
