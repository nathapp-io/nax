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
  /** Verbatim excerpt the reviewer quoted as proof (nax#2486). */
  readonly observed?: string;
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
  /** US-001: the reply carried no status block at all — the ladder's no-work signal. */
  readonly noStatusBlock?: true;
}

export interface StoryReviewVerdict {
  readonly spec: "pass" | "fail";
  readonly quality: "approved" | "changes";
  readonly findings: readonly WorkflowFindingDraft[];
  readonly cannotVerify: readonly string[];
  readonly inspectedFiles: readonly string[];
}

/**
 * US-004 (nax#2524): what remains of a partly fixed finding. A `PARTIAL` re-review verdict carries it,
 * and it replaces the finding's own issue on the same id rather than becoming a second finding.
 */
export interface ReReviewResidual {
  readonly issue: string;
  readonly suggestion?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ReReviewVerdict {
  readonly verdicts: readonly {
    readonly id: string;
    readonly addressed: boolean;
    readonly note: string;
    readonly residual?: ReReviewResidual;
  }[];
  readonly newFindings: readonly WorkflowFindingDraft[];
}

export type MinorTriageDecision = "fix-now" | "leave";

/** The whole-branch review (spec §7 step 2): the story-review verdict plus one triage per deferred minor. */
export interface BranchReviewVerdict extends StoryReviewVerdict {
  readonly minorTriage: readonly { readonly id: string; readonly decision: MinorTriageDecision }[];
}
