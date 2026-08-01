/**
 * ADR-022 Phase 3 — buildPriorIterationsBlock.
 *
 * Verdict-first block that replaced the three legacy carry-forward blocks:
 *   - buildPriorFindingsBlock (adversarial-review-builder.ts) — deleted in ADR-022 phase 5
 *   - buildAttemptContextBlock (review-builder.ts) — deleted in ADR-022 phase 8
 *   - previousFailure accumulator (acceptance-loop.ts) — deleted in ADR-022 phase 8
 *
 * Consumed by all rectifier-class prompts to carry iteration history forward
 * so the model can avoid repeating falsified hypotheses.
 *
 * Issue #736 Patch A: rich finding text (message, file:line, suggestion, acQuote)
 * replaces the count-only table that caused goalpost-moving across review rounds.
 */

import type { Iteration } from "../../findings";
import type { Finding } from "../../findings";

/**
 * Token guard: cap total rendered block at this character count. When exceeded,
 * keep the 2 most recent rounds verbatim and collapse older rounds to one-liners.
 * Prevents prompt blowup on long runs without losing the most recent context.
 */
const MAX_BLOCK_CHARS = 6000;

/**
 * Build the prior iterations block for inclusion in a rectifier prompt.
 *
 * Returns an empty string when there are no prior iterations so callers can
 * unconditionally include it without an "## Prior Iterations" section
 * appearing on the first attempt.
 *
 * Format (ADR-022 §8, issue #736 Patch A):
 *
 * ```
 * ## Prior Iterations — verdict required before new analysis
 *
 * ### Round 1 — outcome: regressed (0 → 1)
 * Findings flagged previously:
 * 1. [error / test-gap] src/foo.ts:42
 *    Message: Missing test for error path
 *    Suggestion: Add a test asserting the function throws on null input
 *    acQuote: "AC3: error path is covered"
 *
 * **Required:** before adding any new finding, classify each of the N prior finding(s)...
 * ```
 */
export function buildPriorIterationsBlock<F extends Finding>(iterations: Iteration<F>[]): string {
  if (iterations.length === 0) return "";

  const sections = iterations.map((iter) => renderIteration(iter));
  const { displaySections, visibleIterations } = applyTokenGuard(sections, iterations);
  const verdictTemplate = renderVerdictTemplate(visibleIterations);

  return [
    "## Prior Iterations — verdict required before new analysis",
    "",
    ...displaySections,
    "",
    verdictTemplate,
    "",
  ].join("\n");
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function applyTokenGuard<F extends Finding>(
  sections: string[],
  iterations: Iteration<F>[],
): { displaySections: string[]; visibleIterations: Iteration<F>[] } {
  if (sections.join("\n\n").length <= MAX_BLOCK_CHARS || sections.length <= 2) {
    return { displaySections: sections, visibleIterations: iterations };
  }

  const n = sections.length;
  const collapsed = iterations
    .slice(0, n - 2)
    .map(
      (iter) =>
        `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${iter.findingsAfter.length} findings, omitted for brevity)`,
    );
  const verbatim = sections.slice(n - 2);

  return { displaySections: [...collapsed, ...verbatim], visibleIterations: iterations.slice(n - 2) };
}

function renderIteration<F extends Finding>(iter: Iteration<F>): string {
  const header = `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${iter.findingsBefore.length} → ${iter.findingsAfter.length})`;
  if (iter.findingsAfter.length === 0) {
    return [header, "_All prior findings cleared._"].join("\n");
  }
  const lines = iter.findingsAfter.map((f, i) => renderFinding(f, i + 1));
  return [header, "Findings flagged previously:", ...lines].join("\n");
}

function renderFinding<F extends Finding>(f: F, n: number): string {
  const message = truncate(f.message ?? "", 240);
  const suggestion = truncate(f.suggestion ?? "", 200);
  const loc = f.file ? (f.line != null ? `${f.file}:${f.line}` : f.file) : "(workdir-global)";
  const tag = `[${f.severity} / ${f.category}]`;
  const ac = typeof f.meta?.acQuote === "string" ? f.meta.acQuote : undefined;
  const acLine = ac ? `\n   acQuote: "${truncate(ac, 160)}"` : "";
  return `${n}. ${tag} ${loc}\n   Message: ${message}\n   Suggestion: ${suggestion}${acLine}`;
}

function renderVerdictTemplate<F extends Finding>(iterations: Iteration<F>[]): string {
  const total = iterations.reduce((sum, it) => sum + it.findingsAfter.length, 0);
  const hasUnchanged = iterations.some((i) => i.outcome === "unchanged");
  const unchangedNote = hasUnchanged
    ? `\n\nWhen outcome is "unchanged", the prior hypothesis is FALSIFIED — the change did not affect what was tested. Choose a different category before producing a new verdict. Do NOT repeat fixes listed above.`
    : "";

  return [
    `**Required:** before adding any new finding, classify each of the ${total} prior finding(s) above as one of:`,
    "- `addressed` — the current diff resolves it; record it in `acks` (not `findings`), citing the diff line that fixes it in `note`",
    "- `still-blocking` — the implementer did not fix it; re-flag it in `findings` with the IDENTICAL `file`, `line`, `category`, and substantively the same `message` wording",
    "- `never-an-issue` — your prior judgment was wrong; record it in `acks` (not `findings`) and explain why in `note`",
    "",
    "Do NOT emit an acknowledgement as a finding. A resolved or withdrawn prior finding is not a defect —",
    "reporting it as one inflates the finding count and buries the real defects. Only `still-blocking` belongs in `findings`.",
    "",
    `Then surface any genuinely new findings.${unchangedNote}`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
