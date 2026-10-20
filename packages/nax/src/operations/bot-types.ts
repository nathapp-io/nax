import type { WorkflowFindingDraft } from "./workflow-types";

export type PrIntent = "pass" | "fail" | "n/a";
export type PrTriageDecision = "agree" | "disagree" | "handled";

export interface PrTriageVerdict {
  readonly id: string;
  readonly decision: PrTriageDecision;
  readonly reason: string;
}

export interface PrReviewVerdict {
  readonly intent: PrIntent;
  readonly quality: "approved" | "changes";
  readonly findings: readonly WorkflowFindingDraft[];
  readonly threads: readonly PrTriageVerdict[];
  readonly comments: readonly PrTriageVerdict[];
  readonly cannotVerify: readonly string[];
  readonly inspectedFiles: readonly string[];
}
