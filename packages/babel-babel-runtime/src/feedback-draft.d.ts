export interface FeedbackDraftCommit {
  status: 'no-fiber' | 'no-draft-hook' | 'pending' | 'committed';
  detail?: string;
}
export interface FeedbackDraftGateDiagnostics {
  /** This lease's preference; another extension may still protect the draft. */
  enabled: boolean;
  effectiveEnabled: boolean;
  pendingHolds: number;
  last: { stepId: string; reason: string; heldMs: number; commit: FeedbackDraftCommit | null; releasedAt: number } | null;
  definitions: { stepId: string; status: string; elapsedMs: number } | null;
  lastError: { stage: string; error: string; at: number } | null;
}
export interface FeedbackDraftGate {
  setEnabled(enabled: boolean): void;
  dispose(): void;
  /** Stable live diagnostics object, compatible with the Helper feedback panel. */
  getDiagnostics(): FeedbackDraftGateDiagnostics;
}
/** MAIN world only. Disabling one lease never disables another active owner. */
export declare function acquireFeedbackDraftGate(owner: string, enabled?: boolean): FeedbackDraftGate;
