/**
 * ADR-022 Phase 3 — buildPriorIterationsBlock.
 *
 * Verdict-first table that replaces the three legacy carry-forward blocks:
 *   - buildPriorFindingsBlock (adversarial-review-builder.ts)
 *   - buildAttemptContextBlock (review-builder.ts)
 *   - previousFailure accumulator (acceptance-loop.ts)
 *
 * Consumed by all rectifier-class prompts to carry iteration history forward
 * so the model can avoid repeating falsified hypotheses.
 */

import type { Iteration } from "../../findings/cycle-types";
import type { Finding } from "../../findings/types";

/**
 * Build the prior iterations block for inclusion in a rectifier prompt.
 *
 * Returns an empty string when there are no prior iterations so callers can
 * unconditionally include it without an "## Prior Iterations" section
 * appearing on the first attempt.
 *
 * Format (ADR-022 §8):
 *
 * ```
 * ## Prior Iterations — verdict required before new analysis
 * | # | Strategies run | Files touched | Outcome | Findings before → after |
 * ...
 * When outcome is "unchanged"...
 * ```
 */
export function buildPriorIterationsBlock<F extends Finding>(iterations: Iteration<F>[]): string {
  if (iterations.length === 0) return "";

  const rows = iterations.map((iter) => {
    const strategies = iter.fixesApplied.map((fa) => fa.strategyName).join(", ") || "-";
    const files = iter.fixesApplied.flatMap((fa) => fa.targetFiles).join(", ") || "-";
    const outcome = iter.outcome;
    const findingSummary = formatFindingSummary(iter.findingsBefore, iter.findingsAfter);
    return `| ${iter.iterationNum} | ${strategies} | ${files} | ${outcome} | ${findingSummary} |`;
  });

  const header = "| # | Strategies run | Files touched | Outcome | Findings before → after |";
  const separator = "|---|----------------|---------------|---------|--------------------------|";
  const table = [header, separator, ...rows].join("\n");

  const hasUnchanged = iterations.some((i) => i.outcome === "unchanged");
  const unchangedNote = hasUnchanged
    ? `\nWhen outcome is "unchanged", the prior hypothesis is FALSIFIED — the change did not affect what was tested. Choose a different category before producing a new verdict. Do NOT repeat fixes listed above.`
    : "";

  return `## Prior Iterations — verdict required before new analysis\n\n${table}${unchangedNote}\n\n`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Format the "Findings before → after" cell content.
 *
 * Shows count and top category per direction. When both sides are empty, shows
 * "resolved". Groups findings by category and shows the most frequent category
 * in brackets (e.g. "2 [stdout-capture]").
 */
function formatFindingSummary<F extends Finding>(before: F[], after: F[]): string {
  const beforeStr = before.length === 0 ? "0" : formatFindingCount(before);
  const afterStr = after.length === 0 ? "0" : formatFindingCount(after);
  return `${beforeStr} → ${afterStr}`;
}

function formatFindingCount<F extends Finding>(findings: F[]): string {
  const count = findings.length;
  const topCategory = mostFrequentCategory(findings);
  return topCategory !== null ? `${count} [${topCategory}]` : `${count}`;
}

function mostFrequentCategory<F extends Finding>(findings: F[]): string | null {
  if (findings.length === 0) return null;
  const freq = new Map<string, number>();
  for (const f of findings) {
    freq.set(f.category, (freq.get(f.category) ?? 0) + 1);
  }
  let top: string | null = null;
  let topCount = 0;
  for (const [cat, cnt] of freq) {
    if (cnt > topCount) {
      topCount = cnt;
      top = cat;
    }
  }
  return top;
}
