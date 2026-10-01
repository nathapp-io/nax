import type { MutationStorySummary } from "../runtime/mutation-summary";

export function formatMutationSummary(summaries: Iterable<MutationStorySummary>): string {
  const lines: string[] = [];
  const notChecked: string[] = [];
  const notRestored: string[] = [];
  for (const summary of summaries) {
    for (const survivor of summary.survivors) {
      const filePath = survivor.file;
      lines.push(`  ${summary.storyId}  ${filePath}:${survivor.line}  ${survivor.operatorId}`);
    }
    if (summary.checked && summary.candidates === 0) notChecked.push(`  ${summary.storyId}`);
    if (summary.revertFailed) notRestored.push(`  ${summary.storyId}`);
  }
  if (lines.length === 0 && notChecked.length === 0 && notRestored.length === 0) return "";
  const blocks: string[] = [];
  if (lines.length > 0) blocks.push("SURVIVING MUTANTS", ...lines);
  if (notChecked.length > 0) blocks.push("NOT CHECKED", ...notChecked);
  // Loudest block last so it is the final thing on screen: this one means the
  // working tree may still be broken, not merely that a check was inconclusive.
  if (notRestored.length > 0) {
    blocks.push(
      "WORKTREE NOT RESTORED — a mutation may still be applied; check the log for file and line",
      ...notRestored,
    );
  }
  return ["", ...blocks, ""].join("\n");
}
