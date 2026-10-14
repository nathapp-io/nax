/** A5 workflow mode — story-loop state and artifact shapes. */
export type {
  BranchReviewVerdict,
  GateName,
  ImplementerReply,
  ImplementerStatus,
  MinorTriageDecision,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowFindingKind,
  WorkflowSeverity,
} from "@/operations";

import type {
  GateName,
  MinorTriageDecision,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowSeverity,
} from "@/operations";

export type GateState = "green" | "red" | "skipped";

export interface GateRunResult {
  readonly red: boolean;
  readonly states: Readonly<Partial<Record<GateName, GateState>>>;
  readonly findings: readonly WorkflowFindingDraft[];
}

export type WorkflowEndState = "complete" | "complete-with-rulings" | "complete-gate-open";

export type WorkflowPhase = "implement" | "gates" | "review" | "fix" | "rereview" | "suite" | "residual" | "closed";

export interface WorkflowRuling {
  readonly findingId?: string;
  readonly action: "hold" | "waive" | "defer" | "carry";
  readonly text: string;
  readonly why: string;
  readonly costIfWrong: string;
  readonly source: "advisor" | "default";
  /** The advisor decision behind this ruling (absent for deterministic defaults). */
  readonly decisionId?: string;
  /** carry only: the dependent stories whose briefs receive the instruction. */
  readonly toStories?: readonly string[];
  /** The advisor asked for a human to confirm this ruling (keeps the PR a draft). */
  readonly needsHumanConfirm?: boolean;
  /** Set when the advisor answered an action the scope does not allow and nax substituted this one (#2496). */
  readonly coercedFrom?: "defer";
}

export interface WorkflowStoryRecord {
  readonly storyId: string;
  readonly state?: WorkflowEndState;
  readonly reason?: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly phase: WorkflowPhase;
  readonly reviewed: boolean;
  readonly unreviewed: boolean;
  readonly openFindings: readonly WorkflowFinding[];
  readonly nextFindingId: number;
  readonly deferredMinors: number;
  readonly rulings: number;
  /** Rulings flagged for a human (hold, or needs confirmation), set at close. */
  readonly flagged?: number;
  readonly gates: Readonly<Partial<Record<GateName, GateState>>>;
  readonly timings: Readonly<Record<string, number>>;
  readonly tokensByRole?: Readonly<Record<string, RoleTokens>>;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface WorkflowResultFile {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly feature: string;
  readonly stories: Readonly<Record<string, WorkflowStoryRecord>>;
  readonly featureWorkflow?: WorkflowFeatureRecord;
  /** #2496: the one place a finishing tool reads. Absent until the feature workflow publishes. */
  readonly verdict?: WorkflowVerdict;
}

/** #2496: one thing still open on a workflow feature, with its evidence in full. */
export interface OpenItem {
  readonly id: string;
  readonly kind: "finding" | "ruling" | "cannot-verify" | "gate";
  readonly severity?: WorkflowSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly issue: string;
  readonly suggestion?: string;
  readonly ruling?: { readonly action: WorkflowRuling["action"]; readonly why: string; readonly decisionId?: string };
}

/** #2496: the feature's top-level verdict in result.json (see the A5 spec appendix). */
export interface WorkflowVerdict {
  readonly workflowPassed: boolean;
  readonly outcome: FeatureOutcome;
  readonly reasons: readonly string[];
  readonly openItems: readonly OpenItem[];
}

export interface RoleTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly calls: number;
}

export type FeatureStep =
  | "repo-gates"
  | "branch-review"
  | "branch-fix"
  | "branch-rereview"
  | "adjudicate"
  | "final-gates"
  | "publish"
  | "done";

/** One runQualityGates pass. Nothing ran = nothing verified (P4-R5). */
export interface RepoGateSummary {
  readonly ran: readonly string[];
  readonly failing: readonly string[];
}

export type FeatureCiState = "green" | "failed" | "pending" | "skipped";
export type FeatureOutcome = "ready" | "draft" | "local-only" | "pushed";

/** A story loop's deferred minor, numbered for the branch review's triage (P4-R7, P4-R8). */
export interface MinorItem {
  readonly id: string;
  readonly storyId: string;
  readonly text: string;
  readonly triage: MinorTriageDecision;
}

export type StoryState = WorkflowEndState | "not-run";

export interface StorySummary {
  readonly id: string;
  readonly title: string;
  readonly state: StoryState;
  readonly reason?: string;
  readonly rounds: number;
  readonly unreviewed: boolean;
  readonly flagged: number;
  /** The run dir holding this story's brief/report (absent when it has no record). */
  readonly runDir?: string;
}

/** The feature workflow's persisted state (spec §7, §10, P4-R1). `step` is the NEXT step to run. */
export interface WorkflowFeatureRecord {
  readonly step: FeatureStep;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** HEAD when the workflow reached `done`. */
  readonly head?: string;
  readonly seed: string | null;
  readonly repoGates?: RepoGateSummary;
  /** Red repo gates and gate-open stories (step 1), handed to the branch fix. */
  readonly gateFindings: readonly WorkflowFinding[];
  readonly reviewRan: boolean;
  /** The branch review's cannot-verify items (#2496: listed as open items, never blocking). */
  readonly cannotVerify?: readonly string[];
  /** Blocking branch-review findings still open. */
  readonly reviewOpen: readonly WorkflowFinding[];
  readonly minors: readonly MinorItem[];
  /** Minor findings raised by the branch review or re-review (PR body, `leave`). */
  readonly newMinors: readonly string[];
  readonly nextFindingId: number;
  readonly fixBase?: string;
  readonly fixRan: boolean;
  /** Branch fix sessions run so far (#2496: at most 2). Absent on records written before #2496. */
  readonly fixRounds?: number;
  /** Round 2 only: the ids of the new findings the second fix targets. */
  readonly fixTargets?: readonly string[];
  readonly rulings: readonly WorkflowRuling[];
  readonly finalGates?: RepoGateSummary;
  /** The excerpts from a red final gate pass, one per failing gate (nax#2484). Absent when the pass is green. */
  readonly finalGateFindings?: readonly WorkflowFindingDraft[];
  readonly ci?: FeatureCiState;
  readonly outcome?: FeatureOutcome;
  readonly reasons: readonly string[];
  readonly url?: string;
  readonly passed?: boolean;
  /**
   * US-005: the ids of the feature's trusted ledger decisions flagged for a human
   * (`needsHumanConfirm`), in ledger order, collected after publish. Absent when
   * nothing was flagged, when the ledger could not be read, or on records written
   * before the step existed.
   */
  readonly flaggedDecisions?: readonly string[];
  readonly timings: Readonly<Record<string, number>>;
  readonly tokensByRole: Readonly<Record<string, RoleTokens>>;
}
