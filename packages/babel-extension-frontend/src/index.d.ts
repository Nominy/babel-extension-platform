export declare class HttpStatusError extends Error {}

export interface SettingsStore<T> {
  loadSettings(): Promise<T>;
  saveSettings(value: T): Promise<T>;
}

export declare function normalizeBaseUrl(value: string): string;
export declare function createJsonClient(config: {
  getBaseCandidates: () => string[];
}): {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, payload: unknown): Promise<T>;
};
export declare function createSettingsStore<T>(config: {
  storageKey: string;
  defaults: T;
  normalize: (input: unknown) => T;
  getStorageArea?: () => {
    get: (key: string, callback: (items: Record<string, unknown> | undefined) => void) => void;
    set: (items: Record<string, unknown>, callback: () => void) => void;
  } | null;
}): SettingsStore<T>;
