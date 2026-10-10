import path from "node:path";
import { isInAcceptanceScope } from "@/prd";
import type { PRD } from "@/prd/types";
import { storyWorkdir } from "@/utils/path-frame";

export interface RefinedCriterionRecord {
  acId: string;
  original: string;
  refined: string;
  storyId: string;
}
export interface FailedCriterion {
  acId: string;
  storyId: string;
  original: string;
  refined: string;
}

export const _failedCriteriaDeps = { readFile: (p: string) => Bun.file(p).text() };

function isRecord(value: unknown): value is RefinedCriterionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["acId", "original", "refined", "storyId"].every((key) => typeof record[key] === "string");
}

export async function loadRefinedCriteria(featureDir: string | undefined): Promise<RefinedCriterionRecord[]> {
  if (!featureDir) return [];
  try {
    const content = await _failedCriteriaDeps.readFile(path.join(featureDir, "acceptance-refined.json"));
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) && parsed.every(isRecord) ? parsed : [];
  } catch {
    return [];
  }
}

export function resolveFailedCriteria(args: {
  refined: readonly RefinedCriterionRecord[];
  groupStoryIds: ReadonlySet<string>;
  failedACs: readonly string[];
}): FailedCriterion[] {
  const numbered = args.refined
    .filter((criterion) => args.groupStoryIds.has(criterion.storyId))
    .map((criterion, index): FailedCriterion => ({ ...criterion, acId: `AC-${index + 1}` }));
  const byId = new Map(numbered.map((criterion) => [criterion.acId, criterion]));
  return args.failedACs.flatMap((acId) => {
    const criterion = byId.get(acId);
    return criterion ? [criterion] : [];
  });
}

export function groupStoryIdsForPackage(prd: PRD, workdir: string, packageDir: string): Set<string> {
  const target = path.resolve(packageDir);
  return new Set(
    prd.userStories
      .filter(isInAcceptanceScope)
      .filter((story) => path.resolve(workdir, storyWorkdir(story)) === target)
      .map((story) => story.id),
  );
}
