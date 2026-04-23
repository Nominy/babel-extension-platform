import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDomLifecycle } from '../src/index.mjs';

test('registerDomLifecycle ensures immediately and on observed DOM churn', () => {
  const calls = [];
  const observer = class {
    constructor(callback) {
      this.callback = callback;
      calls.push('constructed');
    }

    observe(root, options) {
      calls.push(['observe', root.id, options.childList, options.subtree]);
      this.callback();
    }

    disconnect() {
      calls.push('disconnect');
    }
  };

  const originalObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = observer;

  try {
    const dispose = registerDomLifecycle(() => calls.push('ensure'), {
      root: { id: 'root' }
    });
    dispose();
  } finally {
    globalThis.MutationObserver = originalObserver;
  }

  assert.deepEqual(calls, [
    'constructed',
    ['observe', 'root', true, true],
    'ensure',
    'ensure',
    'disconnect'
  ]);
});
