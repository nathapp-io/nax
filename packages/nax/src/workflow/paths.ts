import { join } from "node:path";
import { featureDir } from "@/config";

/**
 * The workflow tree sits inside the repo, under the feature dir, so the agents' file tools
 * can read the briefs, reports and review packages (nax#2479). It is git-ignored through
 * `NAX_GITIGNORE_ENTRIES`, and agents write only the one report path their op declares
 * (`writableOutput`); everything else under `.nax/` stays nax-owned.
 */
export function workflowFeatureDir(projectDir: string, feature: string): string {
  return join(featureDir(projectDir, feature), "workflow");
}

export function workflowRunDir(projectDir: string, feature: string, runId: string): string {
  return join(workflowFeatureDir(projectDir, feature), runId);
}

/** Durable bot state lives outside the disposable checkout's workflow tree. */
export function botRunDir(outputDir: string, prNumber: number, runId: string): string {
  return join(outputDir, "bot", `pr-${prNumber}`, runId);
}

export function workflowStoryDir(runDir: string, storyId: string): string {
  return join(runDir, storyId);
}
