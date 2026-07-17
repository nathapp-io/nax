/**
 * Adversarial review-decision event emission (extracted from adversarial.ts to
 * keep the runner under the 600-line file-size limit).
 */

import type { AdversarialAcceptAnalysis, AdversarialDropAnalysis } from "./ac-structural-counterfactual";

export interface RecordAdversarialAuditOptions {
  runtime?: import("../runtime").NaxRuntime;
  workdir: string;
  projectDir?: string;
  storyId: string;
  featureName?: string;
  parsed: boolean;
  looksLikeFail?: boolean;
  failOpen?: boolean;
  passed?: boolean;
  passReason?: string;
  blockingThreshold?: "error" | "warning" | "info";
  result: { passed: boolean; findings: unknown[] } | null;
  advisoryFindings?: unknown[];
  // Issue #986 — adversarial-only structural counterfactual telemetry.
  diffAvailable?: boolean;
  adversarialDropAnalysis?: AdversarialDropAnalysis[];
  adversarialAcceptAnalysis?: AdversarialAcceptAnalysis[];
}

export function recordAdversarialAudit(opts: RecordAdversarialAuditOptions): void {
  opts.runtime?.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    reviewer: "adversarial",
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    timestamp: Date.now(),
    parsed: opts.parsed,
    looksLikeFail: opts.looksLikeFail,
    failOpen: opts.failOpen,
    passed: opts.passed,
    passReason: opts.passReason,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
    diffAvailable: opts.diffAvailable,
    adversarialDropAnalysis: opts.adversarialDropAnalysis,
    adversarialAcceptAnalysis: opts.adversarialAcceptAnalysis,
  });
}
