export const REVIEW_GRADER_EXTENSION_ID = 'nkeipbljoogklaflfmkiffhflfdpjefc';
export const REVIEW_GRADER_TEST_EXTENSION_ID = 'geagfgdjmeojbkbdjmbchkhjjfpaffbe';
export const REVIEW_GRADER_EXTENSION_IDS = Object.freeze([
  REVIEW_GRADER_EXTENSION_ID,
  REVIEW_GRADER_TEST_EXTENSION_ID
]);
export const REVIEW_GRADER_ACCESS_PORT = 'babel-review-grader-access-v1';
export const REVIEW_GRADER_ACCESS_VERSION = 1;
export const REVIEW_GRADER_ACCESS_CAPABILITY = 'audio-enhancement';
export const REVIEW_GRADER_ACCESS_TIMEOUT_MS = 3000;
export const REVIEW_GRADER_ACCESS_HEARTBEAT_MS = 10000;
export const REVIEW_GRADER_ACCESS_RETRY_MS = 5000;
export const REVIEW_GRADER_ACCESS_IDLE_MS = 30000;
export const REVIEW_GRADER_ACCESS_CLIENT_IDS = Object.freeze([
  'dldjgploldmldipplklepcpjdjhehald',
  'difidgnhacblcogknnfbeedghjpccohh',
  'afpcopjodphibggidgicpjnkgnfhhemi',
  'leabciebbjlkdncpfgaajkoapecdmfde',
  'dcpicphhdpnliknilfmpbdedfndgmdjj'
]);

function isEnvelope(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 5
    && Object.hasOwn(value, 'version') && Object.hasOwn(value, 'type')
    && Object.hasOwn(value, 'capability') && Object.hasOwn(value, 'nonce') && Object.hasOwn(value, 'sequence')
    && value.version === REVIEW_GRADER_ACCESS_VERSION
    && value.capability === REVIEW_GRADER_ACCESS_CAPABILITY
    && typeof value.nonce === 'string' && /^[0-9a-f]{32}$/.test(value.nonce)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0;
}

export function isReviewGraderAccessRequest(value) {
  return isEnvelope(value) && (value.type === 'request' && value.sequence === 0
    || value.type === 'heartbeat' && value.sequence > 0);
}

export function isReviewGraderAccessReply(value) {
  return isEnvelope(value) && (value.type === 'grant' || value.type === 'revoke');
}

function createNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Chrome authenticates the pinned external target; no page/DOM signal participates. */
export function createReviewGraderAccess(runtime = globalThis.chrome?.runtime, options = {}) {
  const timers = options.timers ?? {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: handle => globalThis.clearTimeout(handle)
  };
  const nextNonce = options.createNonce ?? createNonce;
  const listeners = new Set();
  let started = false;
  let disposed = false;
  let available = false;
  let lease = null;
  let session = null;
  let retryTimer = null;
  let initialPromise = null;
  let settleInitial = null;

  function settle(value) {
    const resolve = settleInitial;
    settleInitial = null;
    resolve?.(value);
  }

  function setAvailable(value) {
    if (available === value) return;
    available = value;
    if (value) {
      lease = new AbortController();
    } else {
      const previous = lease;
      lease = null;
      previous?.abort();
    }
    for (const listener of [...listeners]) {
      // A consumer must not interrupt revocation or another consumer's notification.
      try { listener(available); } catch {}
    }
  }

  function retry() {
    if (disposed || retryTimer !== null || typeof runtime?.connect !== 'function') return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      probe();
    }, REVIEW_GRADER_ACCESS_RETRY_MS);
  }

  function nextTarget(targetIndex, remaining) {
    if (disposed) return;
    if (remaining > 1) {
      probe((targetIndex + 1) % REVIEW_GRADER_EXTENSION_IDS.length, remaining - 1);
    } else {
      settle(false);
      retry();
    }
  }

  function close(current) {
    if (session !== current) return;
    session = null;
    if (current.timeout !== null) timers.clearTimeout(current.timeout);
    if (current.heartbeat !== null) timers.clearTimeout(current.heartbeat);
    current.port.onMessage.removeListener(current.onMessage);
    current.port.onDisconnect.removeListener(current.onDisconnect);
    try { current.port.disconnect(); } catch {}
    setAvailable(false);
    nextTarget(current.targetIndex, current.remaining);
  }

  function send(current, type) {
    if (session !== current) return;
    current.awaiting = current.sequence;
    current.timeout = timers.setTimeout(() => close(current), REVIEW_GRADER_ACCESS_TIMEOUT_MS);
    try {
      current.port.postMessage({
        version: REVIEW_GRADER_ACCESS_VERSION, type,
        capability: REVIEW_GRADER_ACCESS_CAPABILITY,
        nonce: current.nonce, sequence: current.sequence
      });
    } catch {
      close(current);
    }
  }

  function probe(targetIndex = 0, remaining = REVIEW_GRADER_EXTENSION_IDS.length) {
    if (disposed || session) return;
    if (typeof runtime?.connect !== 'function') {
      settle(false);
      return;
    }
    const target = REVIEW_GRADER_EXTENSION_IDS[targetIndex];
    let port;
    let nonce;
    try {
      nonce = nextNonce();
      if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) throw new Error('Invalid nonce');
    } catch {
      settle(false);
      retry();
      return;
    }
    try {
      port = runtime.connect(target, { name: REVIEW_GRADER_ACCESS_PORT });
    } catch {
      nextTarget(targetIndex, remaining);
      return;
    }
    const current = {
      port, nonce, targetIndex, remaining, sequence: 0, awaiting: null, timeout: null, heartbeat: null,
      onMessage: null, onDisconnect: null
    };
    session = current;
    current.onMessage = message => {
      if (session !== current) return;
      if (port.sender?.id && port.sender.id !== target
        || !isReviewGraderAccessReply(message) || message.nonce !== nonce
        || message.sequence !== current.awaiting || message.type !== 'grant') {
        close(current);
        return;
      }
      timers.clearTimeout(current.timeout);
      current.timeout = null;
      current.awaiting = null;
      // A healthy lease stays on its provider; a failed lease can try the other pinned target.
      current.remaining = REVIEW_GRADER_EXTENSION_IDS.length;
      setAvailable(true);
      // Subscribers may synchronously dispose during the grant notification.
      if (session !== current) return;
      settle(true);
      current.heartbeat = timers.setTimeout(() => {
        current.heartbeat = null;
        if (!Number.isSafeInteger(++current.sequence)) {
          close(current);
          return;
        }
        send(current, 'heartbeat');
      }, REVIEW_GRADER_ACCESS_HEARTBEAT_MS);
    };
    current.onDisconnect = () => {
      // Chrome exposes missing/disabled targets here; reading lastError consumes it quietly.
      void runtime.lastError;
      close(current);
    };
    port.onMessage.addListener(current.onMessage);
    port.onDisconnect.addListener(current.onDisconnect);
    if (port.name !== REVIEW_GRADER_ACCESS_PORT
      || port.sender?.id && port.sender.id !== target) {
      close(current);
      return;
    }
    send(current, 'request');
  }

  function start() {
    if (disposed) return Promise.resolve(false);
    if (started) return settleInitial ? initialPromise : Promise.resolve(available);
    started = true;
    initialPromise = new Promise(resolve => { settleInitial = resolve; });
    probe();
    return initialPromise;
  }

  return {
    start,
    isAvailable: () => available,
    async acquire() {
      await start();
      return available && !disposed ? lease.signal : null;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      try { listener(available); } catch {}
      void start();
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      if (session) close(session);
      setAvailable(false);
      settle(false);
      listeners.clear();
    }
  };
}
