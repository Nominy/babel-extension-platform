export class HttpStatusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function createJsonClient(config) {
  return {
    async get(path) {
      return requestWithFallback(path, { method: 'GET' }, config.getBaseCandidates());
    },
    async post(path, payload) {
      return requestWithFallback(
        path,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        config.getBaseCandidates()
      );
    }
  };
}

export function createSettingsStore(config) {
  const getStorageArea = config.getStorageArea ?? defaultGetStorageArea;
  return {
    async loadSettings() {
      const storage = getStorageArea();
      const fallback = config.normalize(config.defaults);
      if (!storage) {
        return fallback;
      }

      return new Promise((resolve) => {
        storage.get(config.storageKey, (items) => {
          const runtime = globalThis.chrome?.runtime;
          if (runtime?.lastError) {
            resolve(fallback);
            return;
          }

          resolve(config.normalize(items?.[config.storageKey]));
        });
      });
    },
    async saveSettings(value) {
      const normalized = config.normalize(value);
      const storage = getStorageArea();
      if (!storage) {
        return normalized;
      }

      return new Promise((resolve) => {
        storage.set({ [config.storageKey]: normalized }, () => {
          resolve(normalized);
        });
      });
    }
  };
}

async function requestWithFallback(path, init, baseCandidates) {
  if (!baseCandidates.length) {
    throw new Error('Backend URL is required.');
  }

  const errors = [];
  for (const base of uniq(baseCandidates.map(normalizeBaseUrl).filter(Boolean))) {
    try {
      const response = await fetch(`${base}${path}`, init);
      const data = await parseResponse(response);
      return data;
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof HttpStatusError) {
        throw error;
      }
    }
  }

  throw new Error(`Could not reach backend. Tried: ${errors.join(' | ')}`);
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const errorMessage =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${response.status}: ${text.slice(0, 240)}`;
    throw new HttpStatusError(errorMessage);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Backend returned non-JSON payload.');
  }

  return data;
}

function uniq(values) {
  const out = [];
  for (const value of values) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function defaultGetStorageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}
