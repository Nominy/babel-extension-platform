import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVersionAboveStore, compareExtensionVersions, fetchStoreVersions } from '../src/index.mjs';

const silent = () => {};

test('compareExtensionVersions orders numerically, not lexically', () => {
  assert.equal(compareExtensionVersions('1.0.268', '1.0.9'), 1);
  assert.equal(compareExtensionVersions('1.0.9', '1.0.268'), -1);
  assert.equal(compareExtensionVersions('1.0', '1.0.0'), 0);
  assert.throws(() => compareExtensionVersions('1.0.0-beta', '1.0.0'), /Unsupported extension version/);
});

test('assertVersionAboveStore rejects versions equal to or below the published or submitted revision', () => {
  const store = {
    published: { state: 'PUBLISHED', versions: ['1.0.267'] },
    submitted: { state: 'PENDING_REVIEW', versions: ['1.0.268'] },
    takenDown: false,
    warned: false
  };
  assert.throws(() => assertVersionAboveStore('1.0.267', store, silent), /not greater than the Chrome Web Store published 1\.0\.267 and submitted 1\.0\.268/);
  assert.throws(() => assertVersionAboveStore('1.0.268', store, silent), /submitted 1\.0\.268/);
  assert.doesNotThrow(() => assertVersionAboveStore('1.0.269', store, silent));
});

test('assertVersionAboveStore prints both store versions and passes when the store holds nothing', () => {
  const lines = [];
  assertVersionAboveStore('0.1.34', { published: { state: 'PUBLISHED', versions: ['0.1.33'] }, submitted: null, takenDown: false, warned: false }, (line) => lines.push(line));
  assert.match(lines[0], /published: 0\.1\.33 \[PUBLISHED\]; submitted: none; manifest: 0\.1\.34/);
  assert.doesNotThrow(() => assertVersionAboveStore('0.0.1', { published: null, submitted: null, takenDown: false, warned: false }, silent));
});

test('fetchStoreVersions reads crxVersion from items.fetchStatus revisions', async (t) => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = { url: String(url), authorization: options.headers.Authorization };
    return new Response(
      JSON.stringify({
        name: 'publishers/pub/items/ext',
        publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: '1.0.267' }] },
        takenDown: false
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const versions = await fetchStoreVersions({ publisherId: 'pub', extensionId: 'ext', accessToken: 'token' });
  assert.equal(requested.url, 'https://chromewebstore.googleapis.com/v2/publishers/pub/items/ext:fetchStatus');
  assert.equal(requested.authorization, 'Bearer token');
  assert.deepEqual(versions, {
    published: { state: 'PUBLISHED', versions: ['1.0.267'] },
    submitted: null,
    takenDown: false,
    warned: false
  });
});
