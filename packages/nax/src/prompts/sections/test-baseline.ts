/**
 * Test baseline section (US-004).
 *
 * One bounded, non-overridable section that states what was already failing at
 * the story's base ref, so the implementation roles never spend a turn
 * re-deriving it by running the full suite. Sourced from the persisted story
 * artifact (`resolveStoryBaseline`, US-001); this module only renders.
 *
 * Three shapes, one of which always renders:
 *   - captured with failures — the base ref, the failure count, the failing files;
 *   - captured, zero entries  — the baseline is green at the ref;
 *   - `no-baseline` marker    — no baseline is available, with the marker's reason.
 *
 * Every shape carries the same directive: the baseline is authoritative and the
 * full suite must not be re-run to re-derive it.
 */

import type { TestBaseline } from "@/verification";

const HEADER = "# Test Baseline";

/**
 * The section's standing instruction. Rendered for every shape — including the
 * `no-baseline` marker, where it tells the agent not to go and establish one.
 */
const AUTHORITATIVE_DIRECTIVE = "This baseline is authoritative — do not re-run the full test suite to re-derive it.";

/**
 * Character cap for the rendered section (ADR-022 `MAX_BLOCK_CHARS` precedent).
 * Past it the file list renders the count, the leading files that fit, and an
 * `and N more` tail. The cap is generously above the fixed prologue, so a
 * truncated section still carries its ref, count, and directive.
 */
export const MAX_BASELINE_SECTION_CHARS = 1200;

/**
 * Render the section. Returns a non-empty string for every accepted baseline —
 * callers decide whether to include it at all (a missing artifact renders no
 * section, not an empty one).
 */
export function buildTestBaselineSection(baseline: TestBaseline): string {
  if (baseline.kind === "no-baseline") {
    return [
      HEADER,
      "",
      `No baseline available — the harness could not capture one (\`${baseline.reason}\`).`,
      "",
      AUTHORITATIVE_DIRECTIVE,
    ].join("\n");
  }

  const ref = baseline.baseRef ? `\`${baseline.baseRef}\`` : "the story base ref";

  if (baseline.entries.length === 0) {
    return [
      HEADER,
      "",
      `Baseline green at ${ref} — no test was failing before this story started. Any full-suite failure is introduced by this story.`,
      "",
      AUTHORITATIVE_DIRECTIVE,
    ].join("\n");
  }

  // One line per file: the artifact is keyed `(file, testName?)`, and test names
  // are deliberately omitted here — the gate labels carry that detail.
  const files = [...new Set(baseline.entries.map((entry) => entry.file))];
  const intro = `Captured at ${ref}: ${baseline.entries.length} failing test(s) before this story started.`;
  return renderBounded(intro, files);
}

/**
 * Render the intro plus as many file lines as the cap allows, tailing the rest
 * with an `and N more` line.
 *
 * Each candidate is measured with the tail it would render — the loop breaks
 * before adding a file that does not fit. The `+ 1` absorbs the one thing that
 * measurement cannot see: breaking means the tail counts one *more* file than
 * the candidate did, and a count crossing a power of ten (`9` -> `10`) costs a
 * character. So every accepted candidate is one character clear of the cap.
 */
function renderBounded(intro: string, files: readonly string[]): string {
  const kept: string[] = [];
  for (const file of files) {
    const candidate = [...kept, `- ${file}`];
    const rendered = compose(intro, candidate, files.length - candidate.length);
    if (rendered.length + 1 > MAX_BASELINE_SECTION_CHARS) break;
    kept.push(`- ${file}`);
  }
  return compose(intro, kept, files.length - kept.length);
}

function compose(intro: string, keptFiles: readonly string[], remaining: number): string {
  const lines = [HEADER, "", intro, ...keptFiles];
  if (remaining > 0) lines.push(`- ... and ${remaining} more`);
  lines.push("", AUTHORITATIVE_DIRECTIVE);
  return lines.join("\n");
}
