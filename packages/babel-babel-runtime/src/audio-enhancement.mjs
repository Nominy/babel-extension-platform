export const AUDIO_ENHANCEMENT_PROTOCOL_VERSION = 2;
export const AUDIO_ENHANCEMENT_STATE_ATTRIBUTE = 'data-babel-audio-enhancement';
export const AUDIO_ENHANCEMENT_STATE_EVENT = 'babel-audio-enhancement-state';
export const AUDIO_ENHANCEMENT_ACTIVE_REQUEST = 'babel-audio-enhancement-active-request';
export const AUDIO_ENHANCEMENT_ACTIVE_RESPONSE = 'babel-audio-enhancement-active-response';
let cachedDocument = null;
let cachedRaw = null;
let cachedState = null;

export function isAudioEnhancementStrength(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function isAudioEnhancementProgress(value) {
  return !!value && typeof value === 'object' &&
    ['queued', 'uploading', 'cache-lookup', 'cache-hit', 'loading-model', 'enhancing', 'encoding', 'transferring'].includes(value.phase) &&
    (value.backend === undefined || value.backend === 'webgpu' || value.backend === 'swarm') &&
    !('threads' in value) &&
    (value.backendReason === undefined || value.backend === 'swarm' && typeof value.backendReason === 'string' &&
      value.backendReason.length > 0 && value.backendReason.length <= 256) &&
    typeof value.trackId === 'string' && value.trackId.trim().length > 0 &&
    Number.isSafeInteger(value.trackCount) && value.trackCount > 0 &&
    Number.isSafeInteger(value.trackIndex) && value.trackIndex >= 0 && value.trackIndex < value.trackCount &&
    Number.isSafeInteger(value.totalChunks) && value.totalChunks >= 0 &&
    Number.isSafeInteger(value.completedChunks) && value.completedChunks >= 0 && value.completedChunks <= value.totalChunks &&
    (value.phase !== 'enhancing' || value.totalChunks > 0) &&
    (!['cache-lookup', 'cache-hit'].includes(value.phase) || value.completedChunks === 0 && value.totalChunks === 0);
}

export function readAudioEnhancementState(documentRef = typeof document === 'undefined' ? null : document) {
  let raw;
  try { raw = documentRef?.documentElement?.getAttribute(AUDIO_ENHANCEMENT_STATE_ATTRIBUTE); } catch { return null; }
  if (documentRef === cachedDocument && raw === cachedRaw) return cachedState;
  cachedDocument = documentRef;
  cachedRaw = raw;
  cachedState = null;
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || value.version !== AUDIO_ENHANCEMENT_PROTOCOL_VERSION ||
      typeof value.taskId !== 'string' || !value.taskId ||
      !['idle', 'processing', 'ready', 'switching', 'error'].includes(value.status) ||
      !isAudioEnhancementStrength(value.strength) ||
      !isAudioEnhancementStrength(value.desiredStrength) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.variantKey !== 'string' ||
      (value.pairedVariantKey !== undefined && (typeof value.pairedVariantKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.pairedVariantKey))) ||
      (value.progress !== undefined && !isAudioEnhancementProgress(value.progress))) return null;
  cachedState = Object.freeze(value);
  return cachedState;
}
