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
export declare function findBabelEditorFiber(documentRef?: Document): unknown;
export interface BabelNativeAnnotation {
  id: string;
  type: string;
  content: string | null;
  processedRecordingId: string | null;
  startTimeInSeconds: number | null;
  endTimeInSeconds: number | null;
  [key: string]: unknown;
}
export interface BabelNativeSessionState {
  reviewActionId: string;
  readOnly: boolean;
}
/** MAIN world only; live permissions without reading transcript text or history. */
export declare function readBabelSessionState(documentRef?: Document): BabelNativeSessionState | null;
export interface BabelNativeTurnIdentity extends BabelNativeSessionState {
  annotationId: string;
  processedRecordingId: string | null;
  trackLabel: string;
  startSeconds: number | null;
  endSeconds: number | null;
  isActive: boolean;
}
/** MAIN world only; current annotation metadata without Slate text or selection. */
export declare function readBabelTurnIdentity(annotationId: string, documentRef?: Document): BabelNativeTurnIdentity | null;
export interface BabelNativeTranscriptBindings {
  reviewActionId: string;
  readOnly: boolean;
  annotations: readonly BabelNativeAnnotation[];
  /** Live Slate text not yet committed by its native debounce; raw tag syntax preserved. */
  pendingTextById: Readonly<Record<string, string>>;
  tracks: readonly { id: string; label: string; [key: string]: unknown }[];
  panel: {
    onSave(): unknown;
    onChangeAnnotationContent(id: string, text: string): unknown;
    onChangeAnnotationTrack(id: string, trackId: string): unknown;
    onChangeAnnotationTime(id: string, time: { start?: number; end?: number }): unknown;
    onDeleteAnnotation(id: string): unknown;
    onMergeAnnotations(id: string, direction: 'above' | 'below'): unknown;
    onCreateAnnotation(annotation: Partial<BabelNativeAnnotation>): unknown;
    [key: string]: unknown;
  };
  transcript: {
    turns: readonly BabelNativeAnnotation[];
    handlers: {
      onChangeText(id: string, text: string): unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  controller: {
    annotationsRef: { current: BabelNativeAnnotation[] };
    selectTurn(annotation: BabelNativeAnnotation): unknown;
    updateText(id: string, text: string): unknown;
    updateTime(id: string, time: { start?: number; end?: number }): unknown;
    updateTrack(id: string, trackId: string): unknown;
    split(id: string, seconds: number, texts?: [string, string]): unknown;
    remove(id: string): unknown;
    toggleWarningAssertion(id: string, reason?: string): unknown;
    [key: string]: unknown;
  } | null;
  history: {
    undoStack: readonly { do(): void; undo(): void }[];
    redoStack: readonly { do(): void; undo(): void }[];
    canUndo: boolean;
    canRedo: boolean;
    undo(): void;
    redo(): void;
    executeAndPush(command: { do(): void; undo(): void }): void;
  } | null;
}
/** MAIN world only; current committed state and native callbacks, never DOM approximations. */
export declare function readBabelTranscriptBindings(documentRef?: Document): BabelNativeTranscriptBindings | null;
export interface BabelNativePlaybackBindings {
  reviewActionId: string;
  waves: Array<{
    getCurrentTime(): number;
    getDuration(): number;
    getPlaybackRate(): number;
    isPlaying(): boolean;
  }>;
  seekToTime: ((seconds: number) => void) | null;
  togglePlayPause: (() => void) | null;
  setSpeed: ((speed: string) => void) | null;
}
export declare function readBabelPlaybackBindings(documentRef?: Document): BabelNativePlaybackBindings | null;
export declare function readBabelEditorState(documentRef?: Document): {
  reviewActionId: string;
  tracks: Array<{ id: string; label: string; audioUrl: string }>;
} | null;
export declare function readBabelTrackBindings(documentRef?: Document): {
  reviewActionId: string;
  tracks: Array<{
    id: string; label: string; collapsed: boolean; muted: boolean;
    toggleCollapsed(): void; toggleMuted(): void;
    verticalZoom: number;
    adjustVerticalZoom(value: number): void;
  }>;
  filterValue: string | null;
  setFilter: ((trackId: string) => void) | null;
} | null;
export declare function parseBabelRoute(input?: string | URL): {
  pathname: string;
  searchParams: URLSearchParams;
  reviewActionId: string;
  isTranscriptionRoute: boolean;
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
export { GRADER_PROTOCOL, GRADE_CATEGORIES, GRADE_PREFIXES, validGradeScores, gradingSnapshotKey, type GradeScore } from './review-grading';
export { AUDIO_ENHANCEMENT_PROTOCOL_VERSION, AUDIO_ENHANCEMENT_STATE_ATTRIBUTE, AUDIO_ENHANCEMENT_STATE_EVENT, AUDIO_ENHANCEMENT_ACTIVE_REQUEST, AUDIO_ENHANCEMENT_ACTIVE_RESPONSE, readAudioEnhancementState, isAudioEnhancementProgress, isAudioEnhancementStrength, type AudioEnhancementProgress, type AudioEnhancementCacheStatus, type AudioEnhancementState, type AudioEnhancementTrackMetadata, type AudioEnhancementChunk, type AudioEnhancementResult, type ActiveAudioRequest, type ActiveAudioTrack, type ActiveAudioResponse } from './audio-enhancement';
export { acquireFeedbackDraftGate } from './feedback-draft';
export type { FeedbackDraftGate, FeedbackDraftGateDiagnostics, FeedbackDraftCommit } from './feedback-draft';
