/**
 * Curator Render — Phase 3
 *
 * Renders proposals to markdown format for human review.
 */

import type { Proposal } from "./heuristics";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function actionLabel(action: "add" | "drop" | "advisory"): string {
  if (action === "add") return "Add suggestions";
  if (action === "drop") return "Drop suggestions";
  return "Advisory";
}

/**
 * Render proposals to markdown format.
 *
 * Groups proposals by target action and canonical file, with severity and evidence.
 * Includes timestamp, observation count, and checkbox sections.
 *
 * @param proposals - Array of proposals to render
 * @param runId - Identifier of the run
 * @param observationCount - Total observation count from this run
 * @returns Markdown string
 */
export function renderProposals(proposals: Proposal[], runId: string, observationCount: number): string {
  const ts = formatTimestamp();
  const lines: string[] = [];

  lines.push("# Curator Proposals");
  lines.push("");
  lines.push(`> generated at ${ts} · run ${runId} · ${observationCount} observations`);
  lines.push("");

  if (proposals.length === 0) {
    lines.push(`_No heuristics fired for this run. ${observationCount} observation(s) collected._`);
    return lines.join("\n");
  }

  // Group by action, then by canonicalFile
  const byAction = new Map<"add" | "drop" | "advisory", Map<string, Proposal[]>>();
  for (const proposal of proposals) {
    const { action, canonicalFile } = proposal.target;
    let actionGroup = byAction.get(action);
    if (!actionGroup) {
      actionGroup = new Map();
      byAction.set(action, actionGroup);
    }
    const fileGroup = actionGroup.get(canonicalFile);
    if (fileGroup) {
      fileGroup.push(proposal);
    } else {
      actionGroup.set(canonicalFile, [proposal]);
    }
  }

  const actionOrder: Array<"add" | "drop" | "advisory"> = ["add", "drop", "advisory"];
  for (const action of actionOrder) {
    const actionGroup = byAction.get(action);
    if (!actionGroup) continue;

    lines.push(`## ${action} — ${actionLabel(action)}`);
    lines.push("");

    for (const [canonicalFile, fileProposals] of actionGroup.entries()) {
      lines.push(`### ${canonicalFile}`);
      lines.push("");

      for (const p of fileProposals) {
        const storyList = p.storyIds.join(", ");
        lines.push(`- [ ] [${p.severity}] ${p.id}: ${p.description} — stories: ${storyList}`);
        if (p.evidence) {
          lines.push(`  _Evidence: ${p.evidence}_`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
