/**
 * A5 workflow-mode finding and reply shapes. They live here, not in src/workflow,
 * because the workflow ops parse into them and src/workflow imports src/operations
 * (never the reverse).
 */

export type WorkflowSeverity = "critical" | "important" | "minor";
export type WorkflowFindingKind = "spec" | "quality" | "gate" | "session";
export type GateName = "lint" | "typecheck" | "scoped" | "full-suite";

export interface WorkflowFindingDraft {
  readonly kind: WorkflowFindingKind;
  readonly severity: WorkflowSeverity;
  readonly issue: string;
  readonly file?: string;
  readonly line?: number;
  readonly acId?: string;
  readonly suggestion?: string;
  readonly gate?: GateName;
}

export interface WorkflowFinding extends WorkflowFindingDraft {
  readonly id: string;
}

export type ImplementerStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

export interface ImplementerReply {
  readonly status: ImplementerStatus;
  readonly commits: readonly string[];
  readonly testSummary: string;
  readonly concerns?: string;
  readonly interrupted: boolean;
  /** Set when every agent hop failed ('Agent "x" failed: …'). */
  readonly failure?: string;
}

export interface StoryReviewVerdict {
  readonly spec: "pass" | "fail";
  readonly quality: "approved" | "changes";
  readonly findings: readonly WorkflowFindingDraft[];
  readonly cannotVerify: readonly string[];
}

export interface ReReviewVerdict {
  readonly verdicts: readonly { readonly id: string; readonly addressed: boolean; readonly note: string }[];
  readonly newFindings: readonly WorkflowFindingDraft[];
}
