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

import type { Finding, Iteration } from "@/findings";

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

/**
 * Is this finding stamped with the terminal-advisory `retired` disposition?
 * US-004: a retired finding stays in the iteration store but moves out of the
 * verdict-required list — telling the reviewer to "re-flag" it is the loop
 * retirement exists to break — and into an acknowledgement block that states
 * it is closed.
 */
function isRetired(f: Finding): boolean {
  const rec = f.meta?.recurrence;
  return typeof rec === "object" && rec !== null && (rec as { disposition?: unknown }).disposition === "retired";
}

/**
 * Visible findings for the per-round verdict-required list — every entry in
 * `findingsAfter` EXCEPT those stamped `disposition: "retired"`. The retired
 * entries render once, in the acknowledgement section, named by file and
 * category only.
 */
function visibleFindings<F extends Finding>(iter: Iteration<F>): F[] {
  return iter.findingsAfter.filter((f) => !isRetired(f));
}

/**
 * Retired findings from an iteration, in first-seen order. Each entry is
 * summarised to the (file, category) pair the acknowledgement section names —
 * the message and other fields are intentionally dropped so the section stays
 * a compact index of "what was closed", not a duplicate verdict list.
 */
function retiredEntries<F extends Finding>(iter: Iteration<F>): Array<{ file: string; category: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; category: string }> = [];
  for (const f of iter.findingsAfter) {
    if (!isRetired(f)) continue;
    const file = f.file ?? "(workdir-global)";
    const category = f.category ?? "";
    const key = `${file}|${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, category });
  }
  return out;
}

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
        `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${visibleFindings(iter).length} findings, omitted for brevity)`,
    );
  const verbatim = sections.slice(n - 2);

  return { displaySections: [...collapsed, ...verbatim], visibleIterations: iterations.slice(n - 2) };
}

function renderIteration<F extends Finding>(iter: Iteration<F>): string {
  const visible = visibleFindings(iter);
  const retired = retiredEntries(iter);
  const header = `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${iter.findingsBefore.length} → ${iter.findingsAfter.length})`;
  if (visible.length === 0 && retired.length === 0) {
    return [header, "_All prior findings cleared._"].join("\n");
  }
  const parts: string[] = [header];
  if (visible.length > 0) {
    parts.push("Findings flagged previously:");
    parts.push(...visible.map((f, i) => renderFinding(f, i + 1)));
  }
  if (retired.length > 0) {
    parts.push(...renderAcknowledgement(retired));
  }
  return parts.join("\n");
}

/**
 * Render the acknowledgement section for retired findings. Per AC 2 / AC 3:
 * names each retired finding's file and category, and states the section is
 * for closed findings that must not be re-flagged. One entry per
 * (file, category) pair so a defect re-filed in the same locus across rounds
 * does not produce a duplicated line within a single iteration's section.
 */
function renderAcknowledgement(entries: ReadonlyArray<{ file: string; category: string }>): string[] {
  const lines = entries.map((e) => `- \`${e.file}\` [${e.category}]`);
  return [
    "Acknowledgement — closed findings (must not be re-flagged):",
    ...lines,
    "These findings reached their terminal advisory cap. They are reported, not",
    "acted on — re-flagging them would re-introduce the loop retirement exists",
    "to break. If you believe the close was wrong, surface a new finding with a",
    "distinct `file`, `line`, `category`, and substantively different `message`.",
  ];
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
  const total = iterations.reduce((sum, it) => sum + visibleFindings(it).length, 0);
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
