export const GRADER_PROTOCOL: string;
export const GRADE_CATEGORIES: readonly string[];
export const GRADE_PREFIXES: readonly string[];
export interface GradeScore { category: string; score: 1 | 2 | 3 }
export function validGradeScores(value: unknown): value is GradeScore[];
export function gradingSnapshotKey(original: { actionId: string; actionLevel: number; annotations: any[] }, current: { actionId: string; actionLevel: number; annotations: any[] }): string;
