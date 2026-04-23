export declare function isEditable(element: unknown): boolean;
export declare function isVisible(element: unknown): boolean;
export declare function normalizeText(element: unknown): string;
export declare function setEditableValue(element: unknown, value: unknown): boolean;
export declare function dispatchClick(element: unknown): void;
export declare function sleep(milliseconds: number): Promise<void>;
export declare function waitFor<T>(getValue: () => T | null, timeoutMs?: number, intervalMs?: number): Promise<T | null>;
export declare function registerDomLifecycle(
  ensureMounted: () => void,
  options?: {
    root?: Node;
  }
): () => void;
export declare function getReactInternalValue(element: unknown, prefix: string): unknown;
export declare function getReactFiber(element: unknown): unknown;
export declare function parseBabelRoute(input?: string | URL): {
  pathname: string;
  searchParams: URLSearchParams;
  reviewActionId: string;
  isTranscriptionRoute: boolean;
  isReadOnlyFeedbackRoute: boolean;
};
export declare function createPageBridge(config: {
  commandSource: string;
  eventSource: string;
  injectScriptPath?: string;
  injectScriptDataset?: Record<string, string>;
  postTarget?: string;
}): {
  inject(): void;
  post(type: string, payload?: Record<string, unknown>): void;
  subscribe<T>(type: string, listener: (payload: T) => void): () => void;
};
