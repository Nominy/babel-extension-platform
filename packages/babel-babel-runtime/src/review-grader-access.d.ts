export declare const REVIEW_GRADER_EXTENSION_ID: 'geagfgdjmeojbkbdjmbchkhjjfpaffbe';
export declare const REVIEW_GRADER_ACCESS_PORT: 'babel-review-grader-access-v1';
export declare const REVIEW_GRADER_ACCESS_VERSION: 1;
export declare const REVIEW_GRADER_ACCESS_CAPABILITY: 'audio-enhancement';
export declare const REVIEW_GRADER_ACCESS_TIMEOUT_MS: 3000;
export declare const REVIEW_GRADER_ACCESS_HEARTBEAT_MS: 10000;
export declare const REVIEW_GRADER_ACCESS_RETRY_MS: 5000;
export declare const REVIEW_GRADER_ACCESS_IDLE_MS: 30000;
export declare const REVIEW_GRADER_ACCESS_CLIENT_IDS: readonly string[];

export interface ReviewGraderEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** Structural Chrome runtime types; the shared package has no Chrome type dependency. */
export interface ReviewGraderPort {
  readonly name: string;
  readonly sender?: { readonly id?: string };
  readonly onMessage: ReviewGraderEvent<(message: unknown) => void>;
  readonly onDisconnect: ReviewGraderEvent<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface ReviewGraderRuntime {
  readonly lastError?: { readonly message?: string };
  connect(extensionId: string, connectInfo: { name: string }): ReviewGraderPort;
}

export interface ReviewGraderAccessTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReviewGraderAccessOptions {
  /** Dependency injection for deterministic clocks; production uses browser timers. */
  timers?: ReviewGraderAccessTimers;
  /** Production uses a cryptographically random 128-bit nonce, encoded as 32 lowercase hex digits. */
  createNonce?: () => string;
}

interface ReviewGraderAccessEnvelope {
  version: typeof REVIEW_GRADER_ACCESS_VERSION;
  capability: typeof REVIEW_GRADER_ACCESS_CAPABILITY;
  nonce: string;
  sequence: number;
}

export interface ReviewGraderAccessRequest extends ReviewGraderAccessEnvelope {
  type: 'request' | 'heartbeat';
}

export interface ReviewGraderAccessReply extends ReviewGraderAccessEnvelope {
  type: 'grant' | 'revoke';
}

export declare function isReviewGraderAccessRequest(value: unknown): value is ReviewGraderAccessRequest;
export declare function isReviewGraderAccessReply(value: unknown): value is ReviewGraderAccessReply;

export interface ReviewGraderAccess {
  /** Starts probing; resolves after the initial bounded handshake, false when absent. */
  start(): Promise<boolean>;
  isAvailable(): boolean;
  /** A grant's signal is stable across heartbeats and aborts on disconnect, timeout or disposal. */
  acquire(): Promise<AbortSignal | null>;
  /** Immediately reports the current state and starts probing; unsubscribe removes only this listener. */
  subscribe(listener: (available: boolean) => void): () => void;
  dispose(): void;
}

/** No browser resources are allocated until start, acquire or subscribe. No runtime fails closed. */
export declare function createReviewGraderAccess(
  runtime?: ReviewGraderRuntime,
  options?: ReviewGraderAccessOptions
): ReviewGraderAccess;
