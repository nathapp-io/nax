/**
 * Spec-lint gate — run the linter before the plan spends, not after.
 *
 * `lintSpecContent` (`src/prd/spec-lint.ts`) exists to catch a spec section
 * that the machine parsers cannot see: a `### Modifies` block whose entries all
 * extract to nothing is not an error anywhere downstream, it is simply absent
 * from the PRD. Until #1989 its only caller was `scripts/spec-lint.ts` behind
 * the `spec:lint` npm script, so the guard fired only when an author already
 * suspected a problem — which is never the case for a silent drop. The cost
 * landed as a full plan, then a PRD diff to notice the field was null.
 *
 * ## Why only some findings block
 *
 * Failing the plan on every lint error is not deployable: 26 of this repo's 195
 * specs carry at least one, dominated by `ac-untagged` on specs written before
 * the mechanism tags existed. Those are style debt on already-shipped work.
 *
 * `BLOCKING_SPEC_LINT_CODES` is the narrower set that shares ONE property: the
 * finding means an authorisation the author wrote is being dropped on the floor
 * and nothing downstream will say so. That is the class worth a failed command,
 * because the alternative is a story that deadlocks mid-run against a red suite
 * it has no permission to touch. Everything else is returned for the caller to
 * log and the plan proceeds.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "../errors";
import type { SpecLintFinding } from "../prd";
import { lintSpecContent } from "../prd";

/**
 * Lint codes that fail `nax plan` rather than warn.
 *
 * Every member means the same thing: the spec declares something the extractor
 * could not turn into a PRD entry, and the drop is silent. The `ac-*` codes are
 * deliberately absent — an untagged AC is visible in the PRD and fixable after
 * the fact, so it does not justify refusing to plan.
 */
export const BLOCKING_SPEC_LINT_CODES: ReadonlySet<string> = new Set([
  "modifies-declared-but-empty",
  "modifies-unattributed",
  "modifies-unknown-story",
  "modifies-path-missing",
  "modifies-multi-path-bullet",
  "out-of-scope-not-extractable",
]);

export interface SpecLintGateOptions {
  /** Spec path, for the error message — the author needs to know which file. */
  readonly specPath: string;
  readonly featureName: string;
  /** Project root that spec-declared paths resolve against. */
  readonly workdir: string;
  /** Story-size cap from `precheck.storySizeGate.maxAcCount`. */
  readonly maxAcCount?: number;
  /** Caller opted out (`nax plan --no-spec-lint`) — skip every check. */
  readonly skip?: boolean;
}

/**
 * Lint a spec before planning it.
 *
 * Throws `PLAN_SPEC_LINT_FAILED` when any `BLOCKING_SPEC_LINT_CODES` finding is
 * present. Returns every non-blocking finding so the caller can log it; an empty
 * array means the spec's machine-extracted sections all round-trip.
 */
export function assertSpecLintClean(specContent: string, options: SpecLintGateOptions): readonly SpecLintFinding[] {
  if (options.skip === true) return [];

  const findings = lintSpecContent(specContent, {
    maxAcCount: options.maxAcCount,
    fileExists: (path) => existsSync(join(options.workdir, path)),
  });

  const blocking = findings.filter((finding) => BLOCKING_SPEC_LINT_CODES.has(finding.code));
  if (blocking.length > 0) {
    const detail = blocking.map((finding) => `  [${finding.code}] ${finding.message}`).join("\n");
    throw new NaxError(
      `[plan] ${options.specPath} declares sections that extract to nothing, so the PRD would silently lose them:\n${detail}\nFix the spec, or re-run with --no-spec-lint to plan anyway.`,
      "PLAN_SPEC_LINT_FAILED",
      {
        stage: "plan",
        specPath: options.specPath,
        featureName: options.featureName,
        codes: blocking.map((finding) => finding.code),
      },
    );
  }

  return findings;
}
