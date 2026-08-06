import type { MutationStorySummary } from "../runtime/mutation-summary";

export function formatMutationSummary(summaries: Iterable<MutationStorySummary>): string {
  const lines: string[] = [];
  const notChecked: string[] = [];
  for (const summary of summaries) {
    for (const survivor of summary.survivors) {
      const filePath = survivor.file;
      lines.push(`  ${summary.storyId}  ${filePath}:${survivor.line}  ${survivor.operatorId}`);
    }
    if (summary.checked && summary.candidates === 0) notChecked.push(`  ${summary.storyId}`);
  }
  if (lines.length === 0 && notChecked.length === 0) return "";
  const blocks: string[] = [];
  if (lines.length > 0) blocks.push("SURVIVING MUTANTS", ...lines);
  if (notChecked.length > 0) blocks.push("NOT CHECKED", ...notChecked);
  return ["", ...blocks, ""].join("\n");
}
