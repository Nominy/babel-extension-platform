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

// Captured Babel module 73681, n3 (RecoveredEditorWorkbench), derives its
// tracks from these props. Read the committed tree, never a DOM fiber's stale
// alternate or annotations that disappear when a lane is empty. MAIN world only.
export function findBabelEditorFiber(documentRef = document) {
  const roots = new Set();
  for (const seed of documentRef.querySelectorAll('main, table')) {
    const key = Object.getOwnPropertyNames(seed).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? seed[key] : null;
    const visited = new Set();
    while (fiber?.return && !visited.has(fiber)) {
      visited.add(fiber);
      fiber = fiber.return;
    }
    if (fiber?.stateNode?.current) roots.add(fiber.stateNode.current);
  }
  const pending = [...roots];
  const visited = new Set();
  while (pending.length && visited.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    const props = fiber.memoizedProps;
    if (typeof props?.reviewActionId === 'string' && Array.isArray(props.transcriptionChunkProcessedRecordings)) {
      return fiber;
    }
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
  }
  return null;
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

// Module 73681: n3 owns the WaveSurfer ref; n2 receives transport callbacks;
// t1's Select.onValueChange updates BOTH toolbar state and native playback speed.
// Resolve on every call so callbacks always belong to the committed task.
export function readBabelPlaybackBindings(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  if (!editor) return null;
  let waves = [];
  for (let hook = editor.memoizedState; hook; hook = hook.next) {
    const registry = hook.memoizedState?.current;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) continue;
    const entries = Object.values(registry);
    if (!entries.length || !entries.every(entry => typeof entry?.wavesurfer?.getCurrentTime === 'function')) continue;
    waves = entries.map(entry => entry.wavesurfer);
    break;
  }
  const transport = findDescendant(editor, props =>
    Array.isArray(props?.annotations) && typeof props.onPlayPause === 'function' && typeof props.onSeekToTime === 'function'
  )?.memoizedProps;
  const toolbar = findDescendant(editor, props =>
    props?.reviewActionId === editor.memoizedProps.reviewActionId && typeof props.onSpeedChange === 'function'
  );
  const speedSelect = findDescendant(toolbar, props =>
    typeof props?.value === 'string' && Number.isFinite(Number(props.value)) && typeof props.onValueChange === 'function'
  )?.memoizedProps;
  return {
    reviewActionId: editor.memoizedProps.reviewActionId,
    waves,
    seekToTime: transport?.onSeekToTime ?? null,
    togglePlayPause: transport?.onPlayPause ?? null,
    setSpeed: speedSelect?.onValueChange ?? null
  };
}

// Module 73681: n5 retains lane callbacks even when collapsed; n2's
// track Select owns the "all" / recording-ID annotation filter.
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
      toggleCollapsed: props.onToggleCollapse, toggleMuted: props.onToggleSolo
    } : null;
  });
  if (tracks.some(track => !track)) return null;
  const table = findDescendant(editor, props =>
    Array.isArray(props?.annotations) && typeof props.onSeekToTime === 'function' && Array.isArray(props.tracks)
  );
  const filter = findDescendant(table, props =>
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
  const displayFeedback = searchParams.get('displayFeedback');
  const reviewActionId = searchParams.get('reviewActionId') || '';
  return {
    pathname: url.pathname,
    searchParams,
    reviewActionId,
    isTranscriptionRoute: /^\/transcription(?:\/|$)/.test(url.pathname || ''),
    isReadOnlyFeedbackRoute:
      displayFeedback === 'true' ||
      Boolean(reviewActionId && displayFeedback != null && displayFeedback !== 'false')
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
