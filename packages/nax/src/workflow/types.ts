/** A5 workflow mode — story-loop state and artifact shapes. */
export type {
  BranchReviewVerdict,
  GateName,
  ImplementerReply,
  ImplementerStatus,
  MinorTriageDecision,
  ReReviewResidual,
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
  /** HEAD before the pending fix, retained until its re-review completes. */
  readonly fixBase?: string;
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
  /**
   * US-004: the pre-flight advisor's own spend, metered by `runWorkflowPreflight`. It belongs to
   * no story, so `WorkflowStoryRecord.tokensByRole` could not hold it; `rolesOf` folds it into the
   * end-of-run role table. Absent when the pre-flight dispatched nothing (an adopted earlier
   * pre-flight) and on every result written before this field existed.
   */
  readonly preflightTokensByRole?: Readonly<Record<string, RoleTokens>>;
}

/**
 * #2496: one thing still open on a workflow feature, with its evidence in full. US-002 adds the four
 * kinds a finishing tool had to rebuild by hand: the advisor's hold (`advisor`), a story that did not
 * finish (`story`), the CI state that blocks (`ci`) and a reason no other item explains (`reason`).
 * Only `finding`, `ruling` and `gate` block the verdict.
 */
export interface OpenItem {
  readonly id: string;
  readonly kind: "finding" | "ruling" | "cannot-verify" | "gate" | "advisor" | "story" | "ci" | "reason";
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
  /**
   * US-005 (nax#2525): prompt-cache reads/writes, additive telemetry beside `inputTokens` (which
   * keeps its meaning: uncached input). Absent when the role saw no cache traffic — a record
   * written before this field existed therefore reads as zero, and every older shape is unchanged.
   */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type FeatureStep =
  | "repo-gates"
  | "branch-review"
  | "branch-fix"
  | "branch-rereview"
  | "adjudicate"
  | "final-gates"
  | "gate-repair"
  | "publish"
  | "done";

/** One runQualityGates pass. Nothing ran = nothing verified (P4-R5). */
export interface RepoGateSummary {
  readonly ran: readonly string[];
  readonly failing: readonly string[];
}

export type FeatureCiState = "green" | "failed" | "pending" | "skipped" | "conflicting" | "no-checks" | "unavailable";
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

/**
 * US-001 (nax#2569): the finish-approval advisor's outcome, with the decision behind it. The record
 * keeps the decision id so the verdict can cite the ruling, not only the prose it produced.
 */
export interface ApprovalOutcome {
  readonly approved: boolean;
  readonly rationale: string;
  /** The `AdviceDecision.id` the outcome came from; absent when the advisor answered nothing or threw. */
  readonly decisionId?: string;
}

/** US-001 (nax#2569): one story's end state, as `publish` saw it, for the verdict's open items. */
export interface StoryStateItem {
  readonly id: string;
  readonly state: StoryState;
  readonly reason?: string;
}

/** The feature workflow's persisted state (spec §7, §10, P4-R1). `step` is the NEXT step to run. */
export interface WorkflowFeatureRecord {
  readonly step: FeatureStep;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** HEAD when the workflow reached `done`. */
  readonly head?: string;
  /**
   * nax#2550: HEAD when this record started. A resume on a different HEAD restarts at `repo-gates`,
   * since the recorded gates, review and `fixBase` describe code that is no longer the branch.
   * Absent on records written before this field existed, which resume as they always did.
   */
  readonly startHead?: string;
  /**
   * nax#2550: the HEAD after the last step that can commit (branch fix, gate repair, publish), read by
   * the machine itself. A resume compares the current HEAD to `lastHead ?? startHead`, so the
   * workflow's own commits never force a restart. Absent until such a step ran, and when its read failed.
   */
  readonly lastHead?: string;
  readonly seed: string | null;
  readonly repoGates?: RepoGateSummary;
  /** Red repo gates and gate-open stories (step 1), handed to the branch fix. */
  readonly gateFindings: readonly WorkflowFinding[];
  readonly reviewRan: boolean;
  /**
   * US-003 (nax#2532): the changed files the branch review's verdict did not read, from the
   * verdict `runBranchReview` annotated. Absent when the review read everything (and on every
   * record written before this field existed), so its presence alone means the review was
   * incomplete — `publish` turns it into the reason that keeps the PR a draft.
   */
  readonly reviewUnread?: readonly string[];
  /** nax#2550: an agent step was skipped because the run reached `execution.costLimit`. */
  readonly costLimited?: true;
  /**
   * nax#2550: a branch re-review did not run (timeout, unparseable reply), so the fix commits it was
   * to check are unreviewed. Absent when every re-review ran, and on records written before this
   * field existed; `publish` turns its presence into the reason that keeps the PR a draft.
   */
  readonly reReviewSkipped?: true;
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
  /**
   * Branch fix sessions run so far (#2496), at most `workflow.maxBranchFixRounds` (nax#2547).
   * Absent on records written before #2496.
   */
  readonly fixRounds?: number;
  /** Rounds 2+ only: the ids of the findings the next fix targets (still open or introduced by the last fix). */
  readonly fixTargets?: readonly string[];
  readonly rulings: readonly WorkflowRuling[];
  readonly finalGates?: RepoGateSummary;
  /** The excerpts from a red final gate pass, one per failing gate (nax#2484). Absent when the pass is green. */
  readonly finalGateFindings?: readonly WorkflowFindingDraft[];
  /** nax#2548: the red final-gate excerpts the next repair round targets. */
  readonly gateRepairFindings?: readonly WorkflowFindingDraft[];
  /** nax#2548: repair rounds run for final gates the branch fix turned red. Absent when none ran. */
  readonly gateRepairRounds?: number;
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
  /**
   * US-001 (nax#2569): the advisor's approval outcome, decision id included. Absent when the advisor
   * was never asked — a deterministic reason already kept the PR a draft — and on records written
   * before this field existed.
   */
  readonly approval?: ApprovalOutcome;
  /**
   * US-001 (nax#2569): the CI wait's own `detail` for the three states whose reason is built from it
   * (`conflicting`, `no-checks`, `unavailable`). Absent for every other state, and on records written
   * before this field existed.
   */
  readonly ciDetail?: string;
  /** US-001 (nax#2569): each story's end state as `publish` saw it. Absent on older records. */
  readonly storyStates?: readonly StoryStateItem[];
  readonly timings: Readonly<Record<string, number>>;
  readonly tokensByRole: Readonly<Record<string, RoleTokens>>;
}
