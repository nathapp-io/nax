/**
 * The workflow-mode section of the run summary (nax#2491 P5): where the time went, what each
 * role cost, how many rounds each story took, and what became of the branch findings.
 * Pure presentation over a plain view; src/workflow builds the view from result.json.
 */

import chalk from "chalk";
import { type ChalkLike, createNoopChalk } from "./chalk-like.js";
import { formatCost, formatDuration } from "./formatter.js";
import type { WorkflowSummaryView } from "./types.js";

const ROLE_WIDTH = 16;

/** `stories 139m 53s + feature workflow 17m 35s`. */
export function formatDurationSplit(storiesMs: number, featureWorkflowMs: number): string {
  return `stories ${formatDuration(storiesMs)} + feature workflow ${formatDuration(featureWorkflowMs)}`;
}

const count = (n: number): string => n.toLocaleString("en-US");

function roleLine(r: WorkflowSummaryView["roles"][number]): string {
  const calls = `${r.calls} ${r.calls === 1 ? "call" : "calls"}`;
  return `    ${r.role.padEnd(ROLE_WIDTH)} in ${count(r.inputTokens)}  out ${count(r.outputTokens)}  ${formatCost(r.costUsd)}  ${calls}`;
}

export function formatWorkflowSummary(view: WorkflowSummaryView, options: { useColor?: boolean } = {}): string {
  const c: ChalkLike = options.useColor === false ? createNoopChalk() : chalk;
  const lines: string[] = [];
  lines.push(c.bold(c.blue("  WORKFLOW")));
  lines.push(`  ${c.gray("Duration:")} ${formatDurationSplit(view.storiesDurationMs, view.featureWorkflowDurationMs)}`);
  if (view.roles.length > 0) {
    lines.push(`  ${c.gray("Tokens and cost by role:")}`);
    lines.push(...view.roles.map(roleLine));
  }
  if (view.stories.length > 0) {
    lines.push(`  ${c.gray("Rounds:")} ${view.stories.map((s) => `${s.id} ${s.rounds}/${s.maxRounds}`).join(", ")}`);
  }
  if (view.branch) {
    const b = view.branch;
    lines.push(
      `  ${c.gray("Branch findings:")} ${b.found} found, ${b.fixed} fixed, ${b.left} left (minors left ${b.minorsLeft})`,
    );
  }
  if (view.branchReviewSkipped) {
    const left = view.branchReviewSkipped.minorsLeft;
    lines.push(`  ${c.gray("Branch findings:")} branch review skipped (minors left ${left})`);
  }
  if (view.finalGates) lines.push(`  ${c.gray("Final gates:")} ${view.finalGates}`);
  if (view.publish) {
    const why = view.publish.reasons.length > 0 ? ` - ${view.publish.reasons.join("; ")}` : "";
    const url = view.publish.url ? ` ${view.publish.url}` : "";
    lines.push(`  ${c.gray("Publish: ")} ${view.publish.outcome}${url}${why}`);
  }
  return lines.join("\n");
}
