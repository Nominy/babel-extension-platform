export function isEditable(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  return element.isContentEditable || element.matches('textarea, input');
}

export function isVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function normalizeText(element) {
  if (!(element instanceof HTMLElement)) {
    return '';
  }

  const rawText = typeof element.innerText === 'string' ? element.innerText : element.textContent || '';
  return rawText.replace(/\s+/g, ' ').trim();
}

export function setEditableValue(element, value) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const nextValue = typeof value === 'string' ? value : String(value ?? '');
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;

  if (typeof setter === 'function') {
    setter.call(element, nextValue);
  } else if ('value' in element) {
    element.value = nextValue;
  } else {
    return false;
  }

  try {
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        data: null,
        inputType: 'insertText'
      })
    );
  } catch {
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: false }));
  }

  return true;
}

export function dispatchClick(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  if (typeof PointerEvent === 'function') {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse'
      })
    );
  }

  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  element.click();
}

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export async function waitFor(getValue, timeoutMs = 800, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const value = getValue();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  return null;
}

export function registerDomLifecycle(ensureMounted, options = {}) {
  if (typeof ensureMounted !== 'function') {
    throw new TypeError('registerDomLifecycle requires an ensureMounted callback.');
  }

  const root =
    options.root ||
    (typeof document !== 'undefined' && document.documentElement ? document.documentElement : null);
  let observer = null;

  if (root && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      ensureMounted();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  ensureMounted();

  return () => {
    observer?.disconnect();
  };
}

export function getReactInternalValue(element, prefix) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  for (const name of Object.getOwnPropertyNames(element)) {
    if (typeof name === 'string' && name.startsWith(prefix)) {
      return element[name];
    }
  }

  return null;
}

export function getReactFiber(element) {
  return getReactInternalValue(element, '__reactFiber$');
}

// Cache locations, not Fibers or their props. Every hit follows child/sibling
// links from the committed root; return pointers can belong to a stale alternate.
const nativeLocations = new WeakMap();

function findLocatedDescendant(root, matches, context) {
  if (!root) return null;
  let locations = nativeLocations.get(root) || nativeLocations.get(root.alternate);
  if (!locations) locations = new Map();
  nativeLocations.set(root, locations);
  const location = locations.get(matches);
  if (location) {
    let fiber = root;
    for (const index of location) {
      fiber = fiber?.child;
      for (let sibling = 0; fiber && sibling < index; sibling++) fiber = fiber.sibling;
      if (!fiber) break;
    }
    if (fiber && matches(fiber.memoizedProps, context)) return fiber;
  }
  const pending = [{ fiber: root, parent: null, index: -1 }];
  const visited = new Set();
  while (pending.length && visited.size < 20000) {
    const entry = pending.pop();
    const fiber = entry.fiber;
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    if (matches(fiber.memoizedProps, context)) {
      const path = [];
      for (let edge = entry; edge.parent; edge = edge.parent) path.push(edge.index);
      locations.set(matches, path.reverse());
      return fiber;
    }
    if (entry.parent && fiber.sibling) {
      pending.push({ fiber: fiber.sibling, parent: entry.parent, index: entry.index + 1 });
    }
    if (fiber.child) pending.push({ fiber: fiber.child, parent: entry, index: 0 });
  }
  locations.delete(matches);
  return null;
}

function isEditorProps(props) {
  return typeof props?.reviewActionId === 'string' && Array.isArray(props.transcriptionChunkProcessedRecordings);
}

function isTranscriptPanelProps(props) {
  return Array.isArray(props?.annotations) && props.saveState &&
    typeof props.renderTranscript === 'function' && typeof props.onSave === 'function';
}

function isTranscriptProps(props) {
  return Array.isArray(props?.turns) &&
    (props.editingId === null || typeof props.editingId === 'string') &&
    typeof props.handlers?.onActivate === 'function' &&
    typeof props.handlers.onDeactivate === 'function' &&
    typeof props.handlers.onSelect === 'function' &&
    typeof props.handlers.onChangeText === 'function';
}

function isTransportProps(props) {
  return Array.isArray(props?.annotations) && typeof props.onPlayPause === 'function' &&
    typeof props.onSeekToAnnotation === 'function';
}

function isToolbarProps(props, reviewActionId) {
  return props?.reviewActionId === reviewActionId && typeof props.onSpeedChange === 'function';
}

function isSpeedSelectProps(props) {
  return typeof props?.value === 'string' && Number.isFinite(Number(props.value)) &&
    typeof props.onValueChange === 'function';
}

// The native workbench owns recording identity and WaveSurfer refs. MAIN only.
// Normal reads need the two stable surfaces, not every rendered annotation.
function findBabelEditorLocation(documentRef, rootOnly) {
  const roots = new Set();
  for (const selector of ['main, [data-transcript-scroll]', 'section[data-annotation-id]']) {
    for (const seed of documentRef.querySelectorAll(selector)) {
      const key = Object.getOwnPropertyNames(seed).find((name) => name.startsWith('__reactFiber$'));
      let fiber = key ? seed[key] : null;
      const visited = new Set();
      while (fiber?.return && !visited.has(fiber)) {
        visited.add(fiber);
        fiber = fiber.return;
      }
      const root = fiber?.stateNode?.current;
      if (!root || roots.has(root)) continue;
      roots.add(root);
      const editor = findLocatedDescendant(root, isEditorProps);
      if (editor) return rootOnly ? fiber.stateNode : editor;
    }
  }
  return null;
}

export function findBabelEditorFiber(documentRef = document) {
  return findBabelEditorLocation(documentRef, false);
}

const editorCommitLeaseKey = Symbol.for('@nominy/babel-babel-runtime/editor-commits/v1');

/** Observe the actual committed FiberRoot, never a remembered editor/task. MAIN only. */
export function subscribeBabelEditorCommits(listener, documentRef = document) {
  if (typeof listener !== 'function') throw new TypeError('Editor commit listener must be a function.');
  const root = findBabelEditorLocation(documentRef, true);
  if (!root?.current) {
    throw new Error('Native editor commit root is unavailable.');
  }
  let lease = root[editorCommitLeaseKey];
  const descriptor = Object.getOwnPropertyDescriptor(root, 'current');
  if (lease) {
    if (lease.version !== 1 || descriptor?.get !== lease.get || descriptor?.set !== lease.set) {
      throw new Error('Native editor commit hook ownership was replaced.');
    }
  } else {
    if (!descriptor || !('value' in descriptor) || !descriptor.configurable || !descriptor.writable) {
      throw new Error('Native editor commit root.current must be an own configurable writable data property.');
    }
    lease = {
      version: 1, descriptor, value: descriptor.value, listeners: new Set(), queued: false,
      get() { return lease.value; },
      set(value) {
        lease.value = value;
        if (lease.queued) return;
        lease.queued = true;
        queueMicrotask(() => {
          lease.queued = false;
          if (root[editorCommitLeaseKey] !== lease) return;
          for (const subscription of Array.from(lease.listeners)) {
            if (!lease.listeners.has(subscription)) continue;
            try { subscription.listener(); }
            catch (error) { queueMicrotask(() => { throw error; }); }
          }
        });
      }
    };
    Object.defineProperty(root, editorCommitLeaseKey, { configurable: true, value: lease });
    try {
      Object.defineProperty(root, 'current', {
        configurable: true, enumerable: descriptor.enumerable, get: lease.get, set: lease.set
      });
    } catch (error) {
      delete root[editorCommitLeaseKey];
      throw error;
    }
  }
  const subscription = { listener };
  lease.listeners.add(subscription);
  return () => {
    if (!lease.listeners.delete(subscription) || lease.listeners.size) return;
    const current = Object.getOwnPropertyDescriptor(root, 'current');
    if (root[editorCommitLeaseKey] !== lease) return;
    if (current?.get === lease.get && current?.set === lease.set) {
      Object.defineProperty(root, 'current', { ...lease.descriptor, value: lease.value });
    }
    delete root[editorCommitLeaseKey];
  };
}

export function readBabelEditorState(documentRef = document) {
  const props = findBabelEditorFiber(documentRef)?.memoizedProps;
  if (!props) return null;
  return {
    reviewActionId: props.reviewActionId,
    tracks: props.transcriptionChunkProcessedRecordings.map((recording, index) => ({
      id: recording.processedRecordingId,
      label: props.mode === 'annotation' ? `Recording ${index + 1}`
        : recording.speaker !== null ? `Speaker ${recording.speaker}` : `Track ${index + 1}`,
      audioUrl: recording.processedRecordingUrl ?? ''
    }))
  };
}

function findDescendant(root, matches) {
  const pending = root ? [root] : [];
  const visited = new Set();
  while (pending.length && visited.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    if (matches(fiber.memoizedProps)) return fiber;
    // Never cross from the selected component into its own siblings.
    for (let child = fiber.child; child; child = child.sibling) pending.push(child);
  }
  return null;
}

// A document-owned lease is shared by independently bundled MAIN entrypoints.
// DOM markers are discovery only: every read verifies the current native Fiber.
const classicInputsKey = Symbol.for('babel-helper/classic-inputs/september5-v1');
const classicInputIndexKey = Symbol.for('babel-helper/classic-input-index/september5-v1');

function classicInputs(documentRef, create = false) {
  const descriptor = Object.getOwnPropertyDescriptor(documentRef, classicInputsKey);
  if (descriptor) {
    if (!('value' in descriptor) || !(descriptor.value instanceof Map)) throw new Error('classic-input-registry-invalid');
    return descriptor.value;
  }
  if (!create) return null;
  const inputs = new Map();
  Object.defineProperty(documentRef, classicInputsKey, { value: inputs, configurable: true });
  return inputs;
}

function classicInputIndex(inputs) {
  const descriptor = Object.getOwnPropertyDescriptor(inputs, classicInputIndexKey);
  if (descriptor) {
    if (!('value' in descriptor) || !(descriptor.value?.byId instanceof Map) ||
        !(descriptor.value.roots instanceof WeakMap)) throw new Error('classic-input-index-invalid');
    return descriptor.value;
  }
  const index = { byId: new Map(), roots: new WeakMap() };
  for (const [row, input] of inputs) {
    const id = input.annotation?.id;
    let rows = index.byId.get(id);
    if (!rows) index.byId.set(id, rows = new Set());
    rows.add(row);
  }
  Object.defineProperty(inputs, classicInputIndexKey, { value: index });
  return index;
}

export function registerBabelClassicInput(row, input) {
  const inputs = classicInputs(row.ownerDocument, true);
  if (inputs.has(row) && inputs.get(row) !== input) throw new Error('classic-input-already-owned');
  const index = classicInputIndex(inputs);
  const id = input.annotation?.id;
  let rows = index.byId.get(id);
  if (!rows) index.byId.set(id, rows = new Set());
  rows.add(row);
  inputs.set(row, input);
  return () => {
    if (inputs.get(row) !== input) return;
    inputs.delete(row);
    rows.delete(row);
    if (!rows.size && index.byId.get(id) === rows) index.byId.delete(id);
  };
}

function ownsClassicInput(row, input, root, annotation, committedOwner) {
  const source = input.annotation;
  return Boolean(root && annotation && row.isConnected && row.getAttribute('data-babel-classic-row') === 'true' &&
    row.getAttribute('data-annotation-id') === annotation.id &&
    root.memoizedProps.reviewActionId === input.reviewActionId &&
    source && source.id === annotation.id && source.processedRecordingId === annotation.processedRecordingId &&
    source.startTimeInSeconds === annotation.startTimeInSeconds && source.endTimeInSeconds === annotation.endTimeInSeconds &&
    (source.content ?? '') === (annotation.content ?? '') &&
    committedOwner?.turn?.id === annotation.id && committedOwner.handlers === input.handlers);
}

// Store paths, never authorization-bearing Fibers/props. A single walk indexes
// all registered rows and the two real native surfaces, even in large tasks.
function indexClassicLocations(root, inputs, index) {
  const rows = new WeakMap(), owners = new Map();
  const native = new Map();
  let panel = null, transcript = null;
  const pending = root ? [{ fiber: root, parent: null, index: -1, owner: null }] : [];
  const visited = new Set();
  while (pending.length) {
    const entry = pending.pop(), fiber = entry.fiber;
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    const props = fiber.memoizedProps;
    const owner = typeof props?.turn?.id === 'string' && props.handlers ? props : entry.owner;
    const row = inputs.has(fiber.stateNode) ? fiber.stateNode : null;
    const isPanel = !panel && isTranscriptPanelProps(props);
    const isTranscript = !transcript && isTranscriptProps(props);
    if (row || isPanel || isTranscript) {
      const path = [];
      for (let edge = entry; edge.parent; edge = edge.parent) path.push(edge.index);
      path.reverse();
      if (row) { rows.set(row, path); owners.set(row, owner); }
      if (isPanel) { panel = props; native.set(isTranscriptPanelProps, path); }
      if (isTranscript) { transcript = props; native.set(isTranscriptProps, path); }
    }
    if (entry.parent && fiber.sibling) {
      pending.push({ fiber: fiber.sibling, parent: entry.parent, index: entry.index + 1, owner: entry.owner });
    }
    if (fiber.child) pending.push({ fiber: fiber.child, parent: entry, index: 0, owner });
  }
  if (root) {
    index.roots.set(root, rows);
    const locations = nativeLocations.get(root) || nativeLocations.get(root.alternate) || new Map();
    for (const [matches, path] of native) locations.set(matches, path);
    nativeLocations.set(root, locations);
  }
  return { panel, transcript, owners };
}

function locatedClassicOwner(root, row, index) {
  const locations = index.roots.get(root) || index.roots.get(root?.alternate);
  const path = locations?.get(row);
  if (!path) return null;
  let fiber = root, owner = null;
  for (let depth = 0; fiber; depth++) {
    const props = fiber.memoizedProps;
    if (typeof props?.turn?.id === 'string' && props.handlers) owner = props;
    if (depth === path.length) return fiber.stateNode === row ? owner : null;
    fiber = fiber.child;
    for (let sibling = 0; fiber && sibling < path[depth]; sibling++) fiber = fiber.sibling;
  }
  return null;
}

export function readBabelClassicInput(annotationId, documentRef = document) {
  const inputs = classicInputs(documentRef);
  if (!inputs?.size) return null;
  const index = classicInputIndex(inputs), rows = index.byId.get(annotationId);
  if (!rows?.size) return null;
  const root = findBabelEditorFiber(documentRef);
  if (!root) return null;
  // First use or structural drift rebuilds once, not once per registered row.
  let rebuilt = null;
  if (!index.roots.get(root) && !index.roots.get(root.alternate)) rebuilt = indexClassicLocations(root, inputs, index);
  let panel = rebuilt ? rebuilt.panel : findLocatedDescendant(root, isTranscriptPanelProps)?.memoizedProps;
  let transcript = rebuilt ? rebuilt.transcript : findLocatedDescendant(root, isTranscriptProps)?.memoizedProps;
  for (const row of rows) {
    const input = inputs.get(row);
    if (!input) continue;
    let owner = rebuilt ? rebuilt.owners.get(row) : locatedClassicOwner(root, row, index);
    if (!owner && !rebuilt) {
      rebuilt = indexClassicLocations(root, inputs, index);
      panel = rebuilt.panel; transcript = rebuilt.transcript;
      owner = rebuilt.owners.get(row);
    }
    const annotation = panel && findCurrentAnnotation(panel.annotations, annotationId);
    if (!annotation || !transcript || input.handlers !== transcript.handlers ||
        !ownsClassicInput(row, input, root, annotation, owner)) continue;
    return { row, input, annotation, readOnly: Boolean(root.memoizedProps.readOnly || panel.readOnly ||
      transcript.readOnly || input.readOnly) };
  }
  return null;
}

export function flushBabelClassicInputs(documentRef = document) {
  const inputs = classicInputs(documentRef);
  if (!inputs?.size) return true;
  const root = findBabelEditorFiber(documentRef);
  if (!root) return false;
  const { panel, transcript, owners } = indexClassicLocations(root, inputs, classicInputIndex(inputs));
  if (!panel || !transcript) return false;
  const annotations = new Map(panel.annotations.map(annotation => [annotation.id, annotation]));
  const readOnly = Boolean(root.memoizedProps.readOnly || panel.readOnly || transcript.readOnly);
  const pending = [];
  // Every source and permission is checked before any row's native writer runs.
  // The path index also lets each writer cheaply recheck the current commit.
  for (const [row, input] of inputs) {
    const annotation = annotations.get(input.annotation?.id);
    if (input.handlers !== transcript.handlers || !ownsClassicInput(row, input, root, annotation, owners.get(row))) return false;
    const state = input.read();
    if (state.composing) return false;
    if (state.text !== (annotation.content ?? '')) {
      if (readOnly || input.readOnly) return false;
      pending.push(input);
    }
  }
  for (const input of pending) if (input.flush() === false) return false;
  return true;
}

function pendingNativeText(root, annotations, documentRef) {
  const committed = new Map(annotations.map(annotation => [annotation.id, annotation.content ?? '']));
  const pendingTextById = Object.create(null);
  const inputs = classicInputs(documentRef);
  const ownedInputs = inputs?.size ? new Map() : null;
  const pending = [{ fiber: root, turnId: null, turnOwner: null }];
  const visited = new Set();
  while (pending.length && (inputs?.size || visited.size < 20000)) {
    const { fiber, turnId: inheritedId, turnOwner: inheritedOwner } = pending.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    const props = fiber.memoizedProps;
    const turnId = typeof props?.turn?.id === 'string' ? props.turn.id : inheritedId;
    const turnOwner = typeof props?.turn?.id === 'string' && props.handlers ? props : inheritedOwner;
    const input = inputs?.get(fiber.stateNode);
    if (input && turnOwner) {
      const annotation = findCurrentAnnotation(annotations, turnId);
      if (annotation && ownsClassicInput(fiber.stateNode, input, root, annotation, turnOwner)) {
        ownedInputs.set(annotation.id, input);
      }
    }
    const slate = props?.editor;
    if (turnId && committed.has(turnId) && Array.isArray(slate?.children) &&
      typeof slate.apply === 'function' && typeof slate.insertData === 'function') {
      // Native iD serializes one paragraph, retaining the raw spelling of tags.
      const children = slate.children[0]?.children;
      if (Array.isArray(children)) {
        const text = children.map(node => typeof node.text === 'string' ? node.text : node.raw).join('');
        if (text !== committed.get(turnId)) pendingTextById[turnId] = text;
      }
    }
    for (let child = fiber.child; child; child = child.sibling) pending.push({ fiber: child, turnId, turnOwner });
  }
  if (ownedInputs) for (const [annotationId, input] of ownedInputs) {
    const text = input.read().text;
    // Old TTS Slate has plaintext paragraphs; do not apply modern tag-node
    // serialization to its genuinely owned native editor.
    delete pendingTextById[annotationId];
    if (typeof text === 'string' && text !== committed.get(annotationId)) pendingTextById[annotationId] = text;
  }
  return pendingTextById;
}

/**
 * Authoritative access checks do not need annotations, pending Slate text or
 * native history. Re-read all three current props on every call, including
 * commits that retain the same task ID or reuse the same Fiber objects.
 * @returns {import('./index.js').BabelNativeSessionState | null}
 */
export function readBabelSessionState(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  const panel = findLocatedDescendant(editor, isTranscriptPanelProps)?.memoizedProps;
  const transcript = findLocatedDescendant(editor, isTranscriptProps)?.memoizedProps;
  if (!editor || !panel || !transcript) return null;
  return {
    reviewActionId: editor.memoizedProps.reviewActionId,
    readOnly: Boolean(editor.memoizedProps.readOnly || panel.readOnly || transcript.readOnly)
  };
}

/** Current committed annotation array without Slate, history, or controller discovery. */
export function readBabelAnnotationBindings(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  const panel = findLocatedDescendant(editor, isTranscriptPanelProps)?.memoizedProps;
  if (!editor || !panel) return null;
  return { reviewActionId: editor.memoizedProps.reviewActionId, annotations: panel.annotations };
}

// Native annotation IDs are unique. Cache their positions, not row objects or
// values: a hit must still name the requested ID in the current array slot.
// Reorders/removals/ID changes invalidate that position; misses are never cached.
const nativeAnnotationPositions = new WeakMap();

function findCurrentAnnotation(annotations, annotationId) {
  const positions = nativeAnnotationPositions.get(annotations);
  const position = positions?.get(annotationId);
  const current = position === undefined ? null : annotations[position];
  if (current?.id === annotationId) return current;
  const next = new Map();
  for (let index = 0; index < annotations.length; index++) {
    const id = annotations[index]?.id;
    if (typeof id === 'string' && !next.has(id)) next.set(id, index);
  }
  nativeAnnotationPositions.set(annotations, next);
  const found = next.get(annotationId);
  return found === undefined ? null : annotations[found];
}

/**
 * Row timing/identity reads must not inspect Slate text, selection or history.
 * Array positions are validated against current membership on every read.
 * @returns {import('./index.js').BabelNativeTurnIdentity | null}
 */
export function readBabelTurnIdentity(annotationId, documentRef = document) {
  if (typeof annotationId !== 'string' || !annotationId) return null;
  const editor = findBabelEditorFiber(documentRef);
  const panel = findLocatedDescendant(editor, isTranscriptPanelProps)?.memoizedProps;
  const transcript = findLocatedDescendant(editor, isTranscriptProps)?.memoizedProps;
  if (!editor || !panel || !transcript) return null;
  const annotation = findCurrentAnnotation(panel.annotations, annotationId);
  if (!annotation) return null;
  const processedRecordingId = annotation.processedRecordingId ?? null;
  return {
    reviewActionId: editor.memoizedProps.reviewActionId,
    annotationId,
    processedRecordingId,
    trackLabel: panel.tracks?.find(track => track.id === processedRecordingId)?.label ?? '',
    startSeconds: annotation.startTimeInSeconds ?? null,
    endSeconds: annotation.endTimeInSeconds ?? null,
    isActive: transcript.activeIds?.has(annotationId) === true,
    isEditing: transcript.editingId === annotationId,
    readOnly: Boolean(editor.memoizedProps.readOnly || panel.readOnly || transcript.readOnly)
  };
}

// Current turn editor: the panel owns persistence/history callbacks while the
// transcript owns turn editing callbacks. Resolve both from the same committed
// workbench so filtered/readonly views never substitute stale DOM text.
export function readBabelTranscriptBindings(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  if (!editor) return null;
  const panelFiber = findLocatedDescendant(editor, isTranscriptPanelProps);
  const panel = panelFiber?.memoizedProps;
  if (!panel) return null;
  const transcript = findLocatedDescendant(editor, isTranscriptProps)?.memoizedProps;
  if (!transcript) return null;
  let controller = null;
  for (let hook = editor.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    const value = Array.isArray(state) ? state[0] : state;
    // Match owned native operations, not callable RPC proxies or private refs.
    if (value && typeof value === 'object' && Object.hasOwn(value, 'split') &&
      typeof value.editTurn === 'function' && typeof value.leaveTurn === 'function' &&
      typeof value.selectTurn === 'function' && typeof value.seekTurn === 'function' &&
      typeof value.updateTime === 'function' &&
      typeof value.updateText === 'function' && typeof value.split === 'function' &&
      typeof value.remove === 'function' && typeof value.toggleWarningAssertion === 'function') {
      controller = value;
      break;
    }
  }
  let history = null;
  for (let hook = panelFiber.memoizedState; hook; hook = hook.next) {
    const value = hook.memoizedState;
    if (Array.isArray(value?.undoStack) && Array.isArray(value.redoStack) &&
      typeof value.undo === 'function' && typeof value.redo === 'function' &&
      typeof value.executeAndPush === 'function') {
      // Zustand publishes commands synchronously, before the next React commit.
      // Capture the actual store state, not a render's obsolete stack depth.
      // Fail closed if this is no longer the same native external-store hook.
      if (typeof hook.queue?.getSnapshot === 'function') {
        try {
          const live = hook.queue.getSnapshot();
          if (Array.isArray(live?.undoStack) && Array.isArray(live.redoStack) &&
              live.undo === value.undo && live.redo === value.redo &&
              live.executeAndPush === value.executeAndPush) history = live;
        } catch {
          // An unmounted/inaccessible store cannot authorize native history edits.
        }
      }
      break;
    }
  }
  return {
    reviewActionId: editor.memoizedProps.reviewActionId,
    readOnly: Boolean(editor.memoizedProps.readOnly || panel.readOnly || transcript.readOnly),
    annotations: panel.annotations,
    pendingTextById: pendingNativeText(editor, panel.annotations, documentRef),
    tracks: panel.tracks,
    panel,
    transcript,
    controller,
    history
  };
}

// The workbench retains WaveSurfer refs; native commands are resolved from the
// current tree. Only stable registry membership is reused, never playback clocks.
const nativeWaves = new WeakMap();
const nativeRecordingTracks = new WeakMap();
const noNativeWaves = Object.freeze({ waves: Object.freeze([]), waveTracks: Object.freeze([]) });

function readRegistryWaves(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
  const previous = nativeWaves.get(registry);
  let count = 0;
  let waveTracks = previous?.waveTracks;
  for (const key in registry) {
    if (!Object.prototype.hasOwnProperty.call(registry, key)) continue;
    const wave = registry[key]?.wavesurfer;
    if (typeof wave?.getCurrentTime !== 'function') return null;
    if (!waveTracks || waveTracks[count]?.wave !== wave || waveTracks[count]?.trackId !== key) {
      if (waveTracks === previous?.waveTracks) waveTracks = waveTracks ? waveTracks.slice(0, count) : [];
      waveTracks[count] = { wave, trackId: key };
    }
    count++;
  }
  if (!count) return null;
  if (waveTracks.length !== count) waveTracks = waveTracks.slice(0, count);
  if (waveTracks === previous?.waveTracks) return previous;
  const current = { waves: waveTracks.map(entry => entry.wave), waveTracks };
  nativeWaves.set(registry, current);
  return current;
}

function readEditorWaves(editor) {
  for (let hook = editor.memoizedState; hook; hook = hook.next) {
    const waves = readRegistryWaves(hook.memoizedState?.current);
    if (waves) return waves;
  }
  return noNativeWaves;
}

function readRecordingTracks(props) {
  const recordings = props.transcriptionChunkProcessedRecordings;
  const previous = nativeRecordingTracks.get(recordings);
  let tracks = previous;
  for (let index = 0; index < recordings.length; index++) {
    const recording = recordings[index];
    const id = recording.processedRecordingId;
    const label = props.mode === 'annotation' ? `Recording ${index + 1}`
      : recording.speaker !== null ? `Speaker ${recording.speaker}` : `Track ${index + 1}`;
    if (tracks?.[index]?.id === id && tracks[index].label === label) continue;
    if (tracks === previous) tracks = previous ? previous.slice(0, index) : [];
    tracks[index] = { id, label };
  }
  if (!tracks) tracks = [];
  if (tracks.length !== recordings.length) tracks = tracks.slice(0, recordings.length);
  if (tracks !== previous) nativeRecordingTracks.set(recordings, tracks);
  return tracks;
}

export function readBabelPlaybackBindings(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  if (!editor) return null;
  const membership = readEditorWaves(editor);
  const { waves, waveTracks } = membership;
  const recordingTracks = readRecordingTracks(editor.memoizedProps);
  const transport = findLocatedDescendant(editor, isTransportProps)?.memoizedProps;
  const toolbar = findLocatedDescendant(editor, isToolbarProps, editor.memoizedProps.reviewActionId);
  const speedSelect = findLocatedDescendant(toolbar, isSpeedSelectProps)?.memoizedProps;
  const reviewActionId = editor.memoizedProps.reviewActionId;
  return {
    reviewActionId,
    waves,
    waveTracks,
    recordingTracks,
    isCurrent() {
      const current = findBabelEditorFiber(documentRef);
      if (current?.memoizedProps.reviewActionId !== reviewActionId || readEditorWaves(current) !== membership) return false;
      const tracks = readRecordingTracks(current.memoizedProps);
      if (tracks.length !== recordingTracks.length) return false;
      for (let index = 0; index < tracks.length; index++) {
        if (tracks[index].id !== recordingTracks[index].id || tracks[index].label !== recordingTracks[index].label) return false;
      }
      return true;
    },
    seekToTime: transport ? seconds => {
      const current = findBabelEditorFiber(documentRef);
      if (!Number.isFinite(seconds) || current?.memoizedProps.reviewActionId !== reviewActionId) return;
      // Resolve again if React committed since this command was obtained.
      const currentTransport = findLocatedDescendant(current, isTransportProps)?.memoizedProps;
      // A null recording leaves the selected turn unchanged; the native callback
      // still seeks all tracks through its own synchronization guard.
      currentTransport?.onSeekToAnnotation({ startTimeInSeconds: seconds, processedRecordingId: null });
    } : null,
    togglePlayPause: transport?.onPlayPause ?? null,
    setSpeed: speedSelect?.onValueChange ?? null
  };
}

// Track callbacks remain available while lanes are collapsed. The transcript
// panel's Select owns the "all" / recording-ID annotation filter.
export function readBabelTrackBindings(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  if (!editor) return null;
  const tracks = editor.memoizedProps.transcriptionChunkProcessedRecordings.map(recording => {
    const props = findDescendant(editor, props =>
      props?.track?.id === recording.processedRecordingId &&
      typeof props.onToggleCollapse === 'function' && typeof props.onToggleSolo === 'function'
    )?.memoizedProps;
    return props ? {
      id: props.track.id, label: props.track.label,
      collapsed: props.collapsed, muted: props.isSolo,
      toggleCollapsed: props.onToggleCollapse, toggleMuted: props.onToggleSolo,
      verticalZoom: props.verticalZoom, adjustVerticalZoom: props.onAdjustVerticalZoom
    } : null;
  });
  if (tracks.some(track => !track)) return null;
  const panel = findDescendant(editor, props =>
    Array.isArray(props?.annotations) && typeof props.onSeekToAnnotation === 'function' && Array.isArray(props.tracks)
  );
  const filter = findDescendant(panel, props =>
    typeof props?.onValueChange === 'function' && Array.isArray(props.children) &&
    props.children.some(child => Array.isArray(child?.props?.children) &&
      child.props.children.some(option => option?.props?.value === 'all'))
  )?.memoizedProps;
  return {
    reviewActionId: editor.memoizedProps.reviewActionId, tracks,
    filterValue: filter?.value ?? null, setFilter: filter?.onValueChange ?? null
  };
}

export function parseBabelRoute(
  input = typeof window !== 'undefined' ? window.location.href : 'https://dashboard.babel.audio/'
) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://dashboard.babel.audio';
  const url = input instanceof URL ? input : new URL(String(input), origin);
  const searchParams = new URLSearchParams(url.search || '');
  const reviewActionId = searchParams.get('reviewActionId') || '';
  return {
    pathname: url.pathname,
    searchParams,
    reviewActionId,
    isTranscriptionRoute: /^\/transcription(?:\/|$)/.test(url.pathname || '')
  };
}

export function createPageBridge(config) {
  const postTarget = config.postTarget ?? '*';
  return {
    inject() {
      if (!config.injectScriptPath) {
        return;
      }

      const script = document.createElement('script');
      script.src = config.injectScriptPath;
      for (const [key, value] of Object.entries(config.injectScriptDataset || {})) {
        script.dataset[key] = value;
      }
      script.async = false;
      (document.documentElement || document.head).appendChild(script);
      script.onload = () => script.remove();
    },
    post(type, payload = {}) {
      window.postMessage(
        {
          source: config.commandSource,
          type,
          ...payload
        },
        postTarget
      );
    },
    subscribe(type, listener) {
      const handler = (event) => {
        if (event.source !== window) {
          return;
        }

        const data = event.data;
        if (!data || data.source !== config.eventSource || data.type !== type) {
          return;
        }

        if (data.payload !== undefined) {
          listener(data.payload);
        }
      };

      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    }
  };
}
export { GRADER_PROTOCOL, GRADE_CATEGORIES, GRADE_PREFIXES, validGradeScores, gradingSnapshotKey } from './review-grading.mjs';
export { AUDIO_ENHANCEMENT_PROTOCOL_VERSION, AUDIO_ENHANCEMENT_STATE_ATTRIBUTE, AUDIO_ENHANCEMENT_STATE_EVENT, AUDIO_ENHANCEMENT_ACTIVE_REQUEST, AUDIO_ENHANCEMENT_ACTIVE_RESPONSE, readAudioEnhancementState, isAudioEnhancementProgress, isAudioEnhancementStrength } from './audio-enhancement.mjs';
export { acquireFeedbackDraftGate } from './feedback-draft.mjs';
