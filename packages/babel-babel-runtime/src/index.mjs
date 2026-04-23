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
