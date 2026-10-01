/**
 * Spec-drift detection — deterministic behavioral-fidelity check.
 *
 * Guards against PRD acceptance criteria that have regressed from
 * runtime-testable assertions into file-content greps or shell commands.
 * These patterns indicate spec→PRD drift that the `[verbatim]` preservation
 * check cannot catch because the original spec AC was not tagged `[verbatim]`
 * (docs/findings/nax-plan-prd-fidelity.md §1).
 *
 * This module is pure and deterministic — no LLM, no I/O — so it can back
 * both the `planRefineOp` self-heal turn and the `verify` soft warning without
 * divergence.
 *
 * ## What is detected
 *
 * 1. **Deprecated tags**: an AC leading with `[grep]`, `[file]`, or `[verbatim]`
 *    in the PRD. These tags describe file-content checks the agent cannot
 *    implement as a runtime test. In a spec they are load-bearing markers; in a
 *    PRD they are unimplementable.
 *
 * 2. **Shell-command patterns**: an AC whose backtick-quoted content contains a
 *    shell pipe (`|`), `wc`, or `grep -` — a sign the AC text was copied from
 *    an executable grep assertion rather than rewritten as a behavioral one.
 */

import type { PRD } from "./types";

export interface SpecDriftViolation {
  storyId: string;
  acIndex: number;
  ac: string;
  reason: "deprecated-tag" | "shell-pattern";
}

/** Leading tag group on an AC bullet. */
const LEADING_TAG_GROUP = /^\s*(?:[-*]|\d+\.)?\s*((?:\[[a-z][a-z-]*\]\s*)+)/i;

/** Tags that are banned as leading tags on PRD ACs. */
const DEPRECATED_TAG = /\[(grep|file|verbatim)\]/i;

/**
 * Shell pipe inside a backtick span, anchored to a known shell command on
 * either side. Requiring a command keyword avoids false positives on
 * TypeScript/Rust union types like `Success | Failure` or `'a' | 'b'`.
 */
const SHELL_PIPE = /`[^`]*\b(grep|find|wc|awk|sed|sort|head|tail|xargs|cut|uniq)\b[^`]*\|[^`]*`/i;

/** `wc` command inside a backtick span. */
const SHELL_WC = /`[^`]*\bwc\b[^`]*`/;

/** `grep` followed by a flag inside a backtick span. */
const SHELL_GREP_FLAG = /`[^`]*grep\s+-[a-z]/i;

function leadingTagGroup(ac: string): string | null {
  return ac.match(LEADING_TAG_GROUP)?.[1] ?? null;
}

function hasDeprecatedTag(ac: string): boolean {
  const tags = leadingTagGroup(ac);
  return tags !== null && DEPRECATED_TAG.test(tags);
}

function hasShellPattern(ac: string): boolean {
  return SHELL_PIPE.test(ac) || SHELL_WC.test(ac) || SHELL_GREP_FLAG.test(ac);
}

/**
 * Return every PRD acceptance criterion that exhibits spec-drift: a deprecated
 * leading tag or a shell-command pattern that signals a behavioral regression
 * from a runtime assertion to a file-content check. An empty result means no
 * violations were detected.
 *
 * Accepts `Pick<PRD, "userStories">` so callers can pass a partial draft
 * without the full PRD envelope.
 */
export function findSpecDriftViolations(prd: Pick<PRD, "userStories">): SpecDriftViolation[] {
  const violations: SpecDriftViolation[] = [];
  for (const story of prd.userStories ?? []) {
    for (let i = 0; i < (story.acceptanceCriteria ?? []).length; i++) {
      const ac = story.acceptanceCriteria[i];
      if (hasDeprecatedTag(ac)) {
        violations.push({ storyId: story.id, acIndex: i, ac, reason: "deprecated-tag" });
      } else if (hasShellPattern(ac)) {
        violations.push({ storyId: story.id, acIndex: i, ac, reason: "shell-pattern" });
      }
    }
  }
  return violations;
}
