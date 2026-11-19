import type { FindingTrigger } from "@/workflow/blocking-findings";
import type { WorkflowFindingDraft } from "./workflow-types";

export type PrIntent = "pass" | "fail" | "n/a";
export type PrTriageDecision = "agree" | "disagree" | "handled";

export interface PrTriageVerdict {
  readonly id: string;
  readonly decision: PrTriageDecision;
  readonly reason: string;
}

export type PrEarlierStatus = "open" | "fixed" | "withdrawn";
export interface PrEarlierVerdict {
  readonly id: string;
  readonly status: PrEarlierStatus;
  readonly reason: string;
}
export type PrFinding = WorkflowFindingDraft & {
  readonly decision?: string;
  /** US-001: the condition the finding needs to occur; absent on artifacts written before it. */
  readonly trigger?: FindingTrigger;
  /** US-001: the one detail that shows the trigger class, as the reviewer reported it. */
  readonly triggerEvidence?: string;
};

export interface PrReviewVerdict {
  readonly intent: PrIntent;
  readonly quality: "approved" | "changes";
  readonly findings: readonly PrFinding[];
  readonly earlier?: readonly PrEarlierVerdict[];
  readonly threads: readonly PrTriageVerdict[];
  readonly comments: readonly PrTriageVerdict[];
  readonly cannotVerify: readonly string[];
  readonly inspectedFiles: readonly string[];
}
