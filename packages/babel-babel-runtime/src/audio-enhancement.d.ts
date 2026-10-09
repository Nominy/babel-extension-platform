export declare const AUDIO_ENHANCEMENT_PROTOCOL_VERSION: 2;
export declare const AUDIO_ENHANCEMENT_STATE_ATTRIBUTE: 'data-babel-audio-enhancement';
export declare const AUDIO_ENHANCEMENT_STATE_EVENT: 'babel-audio-enhancement-state';
export declare const AUDIO_ENHANCEMENT_ACTIVE_REQUEST: 'babel-audio-enhancement-active-request';
export declare const AUDIO_ENHANCEMENT_ACTIVE_RESPONSE: 'babel-audio-enhancement-active-response';
export type AudioEnhancementCacheStatus = 'hit' | 'stored' | 'unavailable';
export interface AudioEnhancementProgress {
  phase: 'queued' | 'uploading' | 'cache-lookup' | 'cache-hit' | 'loading-model' | 'enhancing' | 'encoding' | 'transferring';
  trackId: string;
  /** Zero-based current lane, out of trackCount lanes. */
  trackIndex: number;
  trackCount: number;
  /** Completed inference windows, not elapsed-time estimates. */
  completedChunks: number;
  totalChunks: number;
  /** Selected execution route; cache hits do not upload or run inference. */
  backend?: 'webgpu' | 'swarm';
  backendReason?: string;
}
export declare function isAudioEnhancementProgress(value: unknown): value is AudioEnhancementProgress;
export declare function isAudioEnhancementStrength(value: unknown): value is number;
export interface AudioEnhancementState {
  version: 2;
  taskId: string;
  status: 'idle' | 'processing' | 'ready' | 'switching' | 'error';
  /** Committed Enhanced contribution, integer percent 0 (Original) through 100 (Enhanced). */
  strength: number;
  desiredStrength: number;
  revision: number;
  /** Empty at strength 0; stable model/source/mix identity at every nonzero strength. */
  variantKey: string;
  /** Verified Enhanced identity paired to the retained Original with identical sample clocks; also present in Original mode. */
  pairedVariantKey?: string;
  message?: string;
  model?: string;
  progress?: AudioEnhancementProgress;
}
export interface AudioEnhancementTrackMetadata {
  trackId: string;
  speakerKey: string;
  trackLabel: string;
  mimeType: 'audio/wav';
  sampleRate: number;
  frameCount: number;
  sourceSha256: string;
  wavSha256: string;
  totalBytes: number;
  chunkCount: number;
}
export interface AudioEnhancementChunk {
  type: 'audio-chunk';
  trackId: string;
  chunkIndex: number;
  chunkCount: number;
  totalBytes: number;
  dataBase64: string;
}
export interface AudioEnhancementResult {
  ok: true;
  provider: 'browser-local' | 'swarm';
  taskId: string;
  model: string;
  modelSha256: string;
  tracks: AudioEnhancementTrackMetadata[];
  cacheStatus?: AudioEnhancementCacheStatus;
  cacheMessage?: string;
}
export interface ActiveAudioRequest {
  type: typeof AUDIO_ENHANCEMENT_ACTIVE_REQUEST;
  version: 2;
  requestId: string;
  taskId: string;
  selection?: 'active' | 'original';
}
export interface ActiveAudioTrack {
  trackId: string;
  speakerKey: string;
  trackLabel: string;
  mimeType: 'audio/wav';
  bytes: ArrayBuffer;
}
export interface ActiveAudioResponse {
  type: typeof AUDIO_ENHANCEMENT_ACTIVE_RESPONSE;
  version: 2;
  requestId: string;
  taskId: string;
  available: boolean;
  strength: number;
  variantKey: string;
  tracks: ActiveAudioTrack[];
}
export declare function readAudioEnhancementState(documentRef?: Document | null): AudioEnhancementState | null;
