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

  // A finding is "globally retired" if ANY iteration in the history carries it
  // stamped `disposition: "retired"`. Once retired, it stays retired across the
  // whole rendered block — including its earlier-round copy. Without this, the
  // store would carry the same defect in two states (unstamped in round N, stamped
  // retired in round N+1) and the prompt would simultaneously tell the reviewer
  // to re-flag it (verdict list of round N) and not re-flag it (acknowledgement
  // of round N+1). That's the loop retirement exists to break. Dedup uses
  // `findingRecurrenceKey` (file+line+rule, message excluded) so the same
  // defect re-worded across rounds is still recognised as one finding.
  const retiredKeys = new Set<string>();
  for (const iter of iterations) {
    for (const f of iter.findingsAfter) {
      if (isRetired(f)) retiredKeys.add(findingRecurrenceKey(f));
    }
  }

  const sections = iterations.map((iter) => renderIteration(iter, retiredKeys));
  const { displaySections, visibleIterations } = applyTokenGuard(sections, iterations, retiredKeys);
  const verdictTemplate = renderVerdictTemplate(visibleIterations, retiredKeys);
  const acknowledgement = retiredEntriesGlobal(iterations);

  const parts: string[] = ["## Prior Iterations — verdict required before new analysis", ""];
  parts.push(...displaySections);
  if (acknowledgement.length > 0) {
    parts.push("");
    parts.push(...renderAcknowledgement(acknowledgement));
  }
  parts.push("", verdictTemplate, "");

  return parts.join("\n");
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
 * Is this finding globally retired — i.e. retired in some iteration of the
 * rendered block? Used to suppress the verdict-required list copy of a
 * finding whose later-round twin is stamped retired.
 */
function isGloballyRetired(f: Finding, retiredKeys: ReadonlySet<string>): boolean {
  return retiredKeys.has(findingRecurrenceKey(f));
}

/**
 * Local copy of `findingRecurrenceKey` from `@/findings/types`. The barrel
 * `@/findings` re-exports it but is downstream of `cycle.ts`, which is itself
 * reached from the operations barrel — importing the value through that
 * barrel pulls this builder into an existing runtime cycle that
 * `check:import-cycles` ratchets against. The function is a pure
 * JSON.stringify over (source, file, line, rule) with a `findingKey` fallback
 * when neither `line` nor `rule` is set, so the inline is faithful.
 */
function findingRecurrenceKey(f: Finding): string {
  if (f.line == null && f.rule == null) {
    // findingKey fallback: include message so two message-distinct findings
    // in the same file (no line, no rule) don't conflate.
    return JSON.stringify([f.source, f.file ?? null, f.line ?? null, f.rule ?? null, f.message]);
  }
  return JSON.stringify([f.source, f.file ?? null, f.line ?? null, f.rule ?? null]);
}

/**
 * Visible findings for the per-round verdict-required list — every entry in
 * `findingsAfter` EXCEPT those stamped `disposition: "retired"` AND those
 * whose globally-retired twin exists. Retired entries render in the
 * acknowledgement section instead, named by file and category only.
 */
function visibleFindings<F extends Finding>(iter: Iteration<F>, retiredKeys: ReadonlySet<string>): F[] {
  return iter.findingsAfter.filter((f) => !isRetired(f) && !isGloballyRetired(f, retiredKeys));
}

/**
 * Retired findings from the WHOLE history (deduplicated by file+category) so
 * the acknowledgement section lists each closed defect once across all rounds.
 * Renders once at the END of the block (before the verdict template) — not
 * once per round — so the same defect retired in round 2 doesn't re-appear
 * in round 3's section.
 */
function retiredEntriesGlobal<F extends Finding>(
  iterations: readonly Iteration<F>[],
): Array<{
  file: string;
  category: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ file: string; category: string }> = [];
  for (const iter of iterations) {
    for (const f of iter.findingsAfter) {
      if (!isRetired(f)) continue;
      const file = f.file ?? "(workdir-global)";
      const category = f.category ?? "";
      const key = `${file}|${category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, category });
    }
  }
  return out;
}

function applyTokenGuard<F extends Finding>(
  sections: string[],
  iterations: Iteration<F>[],
  retiredKeys: ReadonlySet<string>,
): { displaySections: string[]; visibleIterations: Iteration<F>[] } {
  if (sections.join("\n\n").length <= MAX_BLOCK_CHARS || sections.length <= 2) {
    return { displaySections: sections, visibleIterations: iterations };
  }

  const n = sections.length;
  const collapsed = iterations
    .slice(0, n - 2)
    .map(
      (iter) =>
        `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${visibleFindings(iter, retiredKeys).length} findings, omitted for brevity)`,
    );
  const verbatim = sections.slice(n - 2);

  return { displaySections: [...collapsed, ...verbatim], visibleIterations: iterations.slice(n - 2) };
}

function renderIteration<F extends Finding>(iter: Iteration<F>, retiredKeys: ReadonlySet<string>): string {
  const visible = visibleFindings(iter, retiredKeys);
  const header = `### Round ${iter.iterationNum} — outcome: ${iter.outcome} (${iter.findingsBefore.length} → ${iter.findingsAfter.length})`;
  if (visible.length === 0) {
    return [header, "_All prior findings cleared._"].join("\n");
  }
  const parts: string[] = [header, "Findings flagged previously:"];
  parts.push(...visible.map((f, i) => renderFinding(f, i + 1)));
  return parts.join("\n");
}

/**
 * Render the acknowledgement section for globally-retired findings. Per AC 2 /
 * AC 3: names each retired finding's file and category, and states the section
 * is for closed findings that must not be re-flagged. Rendered once at the end
 * of the block (before the verdict template), not once per round — a defect
 * that reached the retired bucket in round N does not need to be re-listed
 * in every later round's section, and listing it per round would re-introduce
 * the very re-flag mandate the section is meant to break.
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

function renderVerdictTemplate<F extends Finding>(
  iterations: Iteration<F>[],
  retiredKeys: ReadonlySet<string>,
): string {
  const total = iterations.reduce((sum, it) => sum + visibleFindings(it, retiredKeys).length, 0);
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
