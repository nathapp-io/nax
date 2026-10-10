import type { PRD } from "@/prd/types";

export interface RefinedCriterionRecord { acId: string; original: string; refined: string; storyId: string }
export interface FailedCriterion { acId: string; storyId: string; original: string; refined: string }

export const _failedCriteriaDeps = { readFile: (p: string) => Bun.file(p).text() };

export async function loadRefinedCriteria(featureDir: string | undefined): Promise<RefinedCriterionRecord[]> {
  return featureDir ? [{ acId: "", original: "", refined: "", storyId: "" }] : [];
}

export function resolveFailedCriteria(_args: {
  refined: readonly RefinedCriterionRecord[];
  groupStoryIds: ReadonlySet<string>;
  failedACs: readonly string[];
}): FailedCriterion[] {
  return [];
}

export function groupStoryIdsForPackage(_prd: PRD, _workdir: string, _packageDir: string): Set<string> {
  return new Set();
}
