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

// Ignore capture timestamps so refetching unchanged content keeps its identity.
export function gradingSnapshotKey(original, current) {
  const normalize = state => ({ actionId: state.actionId, actionLevel: state.actionLevel,
    annotations: [...state.annotations].sort((a, b) => a.id.localeCompare(b.id)).map(a => ({
      id: a.id, content: a.content, track: a.processedRecordingId, start: a.startTimeInSeconds, end: a.endTimeInSeconds
    })) });
  return JSON.stringify([normalize(original), normalize(current)]);
}
