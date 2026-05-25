import type { Finding } from "../findings/types";
import type { ReviewCheckName, ReviewCheckResult } from "../review/types";

const SOURCE_TO_CHECK: Record<string, ReviewCheckName> = {
  "semantic-review": "semantic",
  "adversarial-review": "adversarial",
  lint: "lint",
  typecheck: "typecheck",
};

/**
 * Group findings by their producer-source and emit one synthetic
 * ReviewCheckResult per group. The prompt builder consumes
 * `check.check`, `check.findings`, and `check.output`; other fields are
 * inert defaults. Findings whose source has no review-check mapping are
 * dropped (they shouldn't reach an autofix strategy — `appliesTo` filters
 * them out upstream, but we stay defensive).
 */
export function findingsToFailedChecks(findings: readonly Finding[]): ReviewCheckResult[] {
  const grouped = new Map<ReviewCheckName, Finding[]>();
  for (const finding of findings) {
    const check = SOURCE_TO_CHECK[finding.source];
    if (!check) continue;
    const bucket = grouped.get(check) ?? [];
    bucket.push(finding);
    grouped.set(check, bucket);
  }

  return [...grouped.entries()].map(([check, grpFindings]) => ({
    check,
    success: false,
    command: "",
    exitCode: 1,
    output: "",
    durationMs: 0,
    findings: grpFindings,
  }));
}
