/**
 * Output factories for the review/diagnosis callOp dep slots.
 *
 * The slots are annotated monomorphically (#1514 callop-seam): a stub must
 * return the complete required-field set or the fixture is incomplete.
 * These factories supply the fields each test does not care about.
 */

import type { AcceptanceDiagnoseOutput } from "@/operations/acceptance-diagnose";
import type { AdversarialReviewOutput } from "@/operations/adversarial-review";
import type { SemanticReviewOutput } from "@/operations/semantic-review";

export function makeAdversarialOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

export function makeSemanticOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

export function makeDiagnoseOutput(overrides: Partial<AcceptanceDiagnoseOutput> = {}): AcceptanceDiagnoseOutput {
  return { verdict: "test_bug", reasoning: "", confidence: 1, ...overrides };
}
