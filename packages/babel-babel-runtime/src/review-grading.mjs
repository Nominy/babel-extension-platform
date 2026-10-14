export const GRADER_PROTOCOL = 'babel-review-grader-v1';
export const GRADE_CATEGORIES = Object.freeze([
  'Word Accuracy', 'Timestamp Accuracy', 'Punctuation & Formatting', 'Tags & Emphasis', 'Segmentation'
]);
export const GRADE_PREFIXES = Object.freeze(['wordAccuracy', 'timestampAccuracy', 'punctuationFormatting', 'tagsEmphasis', 'segmentation']);

export function validGradeScores(value) {
  return Array.isArray(value) && value.length === GRADE_CATEGORIES.length
    && GRADE_CATEGORIES.every(category => value.filter(item => item?.category === category
      && Number.isInteger(item.score) && item.score >= 1 && item.score <= 3).length === 1);
}

function canonicalMetadata(value) {
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalMetadata(value[key])]));
  }
  return value;
}

// Ignore capture timestamps so refetching unchanged content keeps its identity.
export function gradingSnapshotKey(original, current) {
  const normalize = state => ({ actionId: state.actionId, actionLevel: state.actionLevel,
    annotations: [...state.annotations].sort((a, b) => a.id.localeCompare(b.id)).map(a => ({
      id: a.id, type: a.type ?? null, content: a.content, track: a.processedRecordingId,
      start: a.startTimeInSeconds, end: a.endTimeInSeconds, intensity: a.intensity ?? null,
      metadata: canonicalMetadata(a.metadata ?? null)
    })) });
  return JSON.stringify([normalize(original), normalize(current)]);
}
