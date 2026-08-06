import type { MutationStorySummary } from "../runtime/mutation-summary";

export function formatMutationSummary(summaries: Iterable<MutationStorySummary>): string {
  const lines: string[] = [];
  for (const summary of summaries) {
    for (const survivor of summary.survivors) {
      const filePath = survivor.filePath ?? survivor.file ?? "";
      lines.push(`  ${summary.storyId}  ${filePath}:${survivor.line}  ${survivor.operatorId}`);
    }
  }
  if (lines.length === 0) return "";
  return ["", "SURVIVING MUTANTS", ...lines, ""].join("\n");
}
