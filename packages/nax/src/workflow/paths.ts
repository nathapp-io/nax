import { join } from "node:path";

/** `<outputDir>/<project>` is runtime.outputDir; the workflow tree sits under it. */
export function workflowFeatureDir(outputDir: string, feature: string): string {
  return join(outputDir, "workflow", feature);
}

export function workflowRunDir(outputDir: string, feature: string, runId: string): string {
  return join(workflowFeatureDir(outputDir, feature), runId);
}

export function workflowStoryDir(runDir: string, storyId: string): string {
  return join(runDir, storyId);
}
