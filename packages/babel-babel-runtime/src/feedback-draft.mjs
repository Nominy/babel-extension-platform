import { findBabelEditorFiber } from './index.mjs';

const SINGLETON = Symbol.for('babel.feedback-draft-gate.v1');
const DEFINITIONS = 'forms.getFormInputsByStepId';
const DRAFT = 'transcriptionFeedbackForm.getOrCreateDraft';
const HOLD_TIMEOUT_MS = 8000;
const COMMIT_GRACE_MS = 1500;
const POLL_MS = 25;

function procedureInput(payload, index) {
  if (!payload || typeof payload !== 'object') return null;
  const entry = Object.hasOwn(payload, String(index)) ? payload[String(index)] : payload;
  return entry?.json && typeof entry.json === 'object' ? entry.json : entry;
}

function queryMatches(key, procedure, stepId) {
  if (!Array.isArray(key)) return false;
  const text = JSON.stringify(key);
  return text.includes(procedure.slice(procedure.lastIndexOf('.') + 1))
    && (!stepId || text.includes(JSON.stringify(stepId)));
}

// The recovered native mutation maps draft values once, through its labels ref.
// Query delivery alone is insufficient: wait for the matching labels to commit.
function inspectCommit(stepId) {
  try {
    const fiber = findBabelEditorFiber(document);
    if (!fiber) return { status: 'no-fiber' };
    const seen = new Set();
    let draftMutation = false, definitions = null, labels = null;
    for (let hook = fiber.memoizedState; hook && !seen.has(hook); hook = hook.next) {
      seen.add(hook);
      const state = hook.memoizedState;
      if (!state || typeof state !== 'object') continue;
      const options = state.options;
      if (options && typeof options === 'object') {
        if (!draftMutation && queryMatches(options.mutationKey, DRAFT, null)) draftMutation = true;
        else if (!definitions && typeof state.getCurrentResult === 'function' && queryMatches(options.queryKey, DEFINITIONS, stepId)) {
          const result = state.getCurrentResult();
          if (Array.isArray(result?.data)) definitions = result.data;
        }
      } else if (!labels && Array.isArray(state.current) && state.current.length
        && state.current.every(entry => entry && typeof entry.id === 'string' && typeof entry.label === 'string' && Object.keys(entry).length === 2)) {
        labels = state.current;
      }
    }
    if (!draftMutation) return { status: 'no-draft-hook' };
    if (!definitions) return { status: 'pending', detail: 'definitions-query-empty' };
    if (!definitions.length) return { status: 'committed' };
    return labels && labels.length === definitions.length && labels.every((entry, index) => entry.id === definitions[index]?.id)
      ? { status: 'committed' }
      : { status: 'pending', detail: labels ? 'labels-stale' : 'labels-unset' };
  } catch (error) {
    return { status: 'no-fiber', detail: String(error?.message ?? error) };
  }
}

function createGate() {
  const owners = new Map();
  const definitions = new Map();
  const holds = new Set();
  const diagnostics = { pendingHolds: 0, last: null, definitions: null, lastError: null };
  let enabled = false, suspended = false, installed = false, upstream = null, timer = 0;
  const route = () => typeof window.location.pathname === 'string'
    ? window.location.pathname + window.location.search
    : window.location.href.split('#')[0];

  function publish() {
    diagnostics.pendingHolds = holds.size;
    for (const owner of owners.values()) Object.assign(owner.diagnostics, diagnostics, { enabled: owner.enabled, effectiveEnabled: enabled });
  }

  function recordError(error, stage) {
    diagnostics.lastError = { stage, error: String(error?.message ?? error), at: Date.now() };
    publish();
  }

  function release(hold, reason) {
    holds.delete(hold);
    diagnostics.last = { stepId: hold.stepId, reason, heldMs: Date.now() - hold.startedAt, commit: hold.commit, releasedAt: Date.now() };
    publish();
    hold.resolve(hold.response);
  }

  function releaseAll(reason) {
    for (const hold of holds) release(hold, reason);
    if (timer) window.clearTimeout(timer);
    timer = 0;
    definitions.clear();
  }

  function evaluate(hold) {
    if (!enabled) return 'disabled';
    if (hold.routeKey !== route()) return 'stale-task';
    hold.commit = inspectCommit(hold.stepId);
    if (hold.commit.status === 'committed') return 'committed';
    let latest = null;
    for (const entry of definitions.values()) {
      if (entry.routeKey === hold.routeKey && (!hold.stepId || !entry.stepId || entry.stepId === hold.stepId)
        && (!latest || entry.startedAt >= latest.startedAt)) latest = entry;
    }
    if (!latest) {
      if (hold.commit.status !== 'pending') return 'no-definitions-request';
    } else if (latest.status === 'failed') return 'definitions-failed';
    else if (latest.status === 'delivered' && Date.now() - latest.settledAt >= COMMIT_GRACE_MS) return 'commit-grace-elapsed';
    return Date.now() - hold.startedAt >= HOLD_TIMEOUT_MS ? 'timeout' : null;
  }

  function pump() {
    for (const hold of holds) {
      let reason;
      try { reason = evaluate(hold); }
      catch (error) { recordError(error, 'evaluate'); reason = 'error'; }
      if (reason) release(hold, reason);
    }
    if (!holds.size && timer) { window.clearTimeout(timer); timer = 0; }
    if (!timer && holds.size) timer = window.setTimeout(() => { timer = 0; pump(); }, POLL_MS);
  }

  function sync() {
    enabled = false;
    if (!suspended) for (const owner of owners.values()) if (owner.enabled) { enabled = true; break; }
    if (enabled && !installed) {
      if (window.fetch !== gatedFetch) upstream = window.fetch;
      window.fetch = gatedFetch;
      installed = true;
    } else if (!enabled) {
      releaseAll('disabled');
      // Never replace a wrapper belonging to another extension. A buried gate
      // remains inert until enabled again; its captured upstream never changes.
      if (installed && window.fetch === gatedFetch) {
        window.fetch = upstream;
        installed = false;
      }
    }
    publish();
  }

  async function gatedFetch(input, init) {
    const fetchUpstream = upstream;
    if (!enabled) return fetchUpstream.call(window, input, init);
    let request = null;
    try {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), window.location.origin || window.location.href);
      const prefix = '/api/trpc/';
      const start = url.pathname.indexOf(prefix);
      if (start !== -1) {
        const procedures = url.pathname.slice(start + prefix.length).split(',');
        const definitionsIndex = procedures.indexOf(DEFINITIONS), draftIndex = procedures.indexOf(DRAFT);
        // Holding a batch carrying its own definitions would deadlock hydration.
        if (!(definitionsIndex !== -1 && draftIndex !== -1)) {
          if (draftIndex !== -1) request = { kind: 'draft', index: draftIndex };
          else if (definitionsIndex !== -1) request = { kind: 'definitions', index: definitionsIndex, url };
        }
      }
    } catch (error) { recordError(error, 'classify'); }
    if (!request) return fetchUpstream.call(window, input, init);
    const routeKey = route();
    if (request.kind === 'definitions') {
      const response = fetchUpstream.call(window, input, init);
      try {
        const payload = procedureInput(JSON.parse(request.url.searchParams.get('input') || 'null'), request.index);
        const stepId = typeof payload?.stepId === 'string' ? payload.stepId : '';
        const entry = { stepId, routeKey, status: 'pending', startedAt: Date.now(), settledAt: 0 };
        definitions.set(stepId, entry);
        const settle = status => {
          if (!enabled || routeKey !== route() || definitions.get(stepId) !== entry) return;
          entry.status = status; entry.settledAt = Date.now();
          diagnostics.definitions = { stepId, status, elapsedMs: entry.settledAt - entry.startedAt };
          publish(); pump();
        };
        Promise.resolve(response).then(value => settle(value?.ok === false ? 'failed' : 'delivered'), () => settle('failed'));
      } catch (error) { recordError(error, 'definitions'); }
      return response;
    }
    let stepId = '';
    try {
      const body = typeof init?.body === 'string' ? init.body : typeof input?.clone === 'function' ? await input.clone().text() : '';
      const payload = procedureInput(JSON.parse(body || 'null'), request.index);
      stepId = typeof payload?.formStepId === 'string' ? payload.formStepId : '';
    } catch (error) { recordError(error, 'draft-request'); }
    const response = await fetchUpstream.call(window, input, init);
    const hold = { stepId, routeKey, response, startedAt: Date.now(), commit: null, resolve: null };
    try {
      const reason = evaluate(hold);
      if (reason) {
        diagnostics.last = { stepId, reason, heldMs: Date.now() - hold.startedAt, commit: hold.commit, releasedAt: Date.now() };
        publish();
        return response;
      }
      const promise = new Promise(resolve => { hold.resolve = resolve; });
      holds.add(hold); publish(); pump();
      return promise;
    } catch (error) { recordError(error, 'hold'); return response; }
  }

  const navigation = () => { pump(); for (const [key, entry] of definitions) if (entry.routeKey !== route()) definitions.delete(key); };
  const hide = () => { suspended = true; sync(); };
  const show = () => { suspended = false; sync(); };

  return {
    acquire(name, ownerEnabled) {
      const token = Symbol(name);
      const owner = { enabled: ownerEnabled, diagnostics: { ...diagnostics, enabled: ownerEnabled, effectiveEnabled: enabled } };
      if (!owners.size) {
        suspended = false;
        window.addEventListener('popstate', navigation);
        window.addEventListener('hashchange', navigation);
        window.addEventListener('pagehide', hide);
        window.addEventListener('pageshow', show);
      }
      owners.set(token, owner); sync();
      let disposed = false;
      return {
        setEnabled(nextEnabled) { if (!disposed) { owner.enabled = Boolean(nextEnabled); sync(); } },
        getDiagnostics() { return owner.diagnostics; },
        dispose() {
          if (disposed) return;
          disposed = true; owner.enabled = false;
          owners.delete(token); sync();
          Object.assign(owner.diagnostics, diagnostics, { enabled: false, effectiveEnabled: enabled });
          if (!owners.size) {
            window.removeEventListener('popstate', navigation);
            window.removeEventListener('hashchange', navigation);
            window.removeEventListener('pagehide', hide);
            window.removeEventListener('pageshow', show);
          }
        }
      };
    }
  };
}

/** MAIN world only. Each enabled consumer owns one lease on the shared gate. */
export function acquireFeedbackDraftGate(owner, enabled = true) {
  if (typeof owner !== 'string' || !owner) throw new TypeError('A feedback draft gate owner name is required.');
  window[SINGLETON] ??= createGate();
  return window[SINGLETON].acquire(owner, Boolean(enabled));
}
