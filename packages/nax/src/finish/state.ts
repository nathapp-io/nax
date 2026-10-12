import { NaxError } from "../errors";
import type {
  AcceptanceFact,
  Finding,
  FinishPhase,
  FinishResolution,
  FinishResultStatus,
  FixBase,
  GateFact,
  HandoffRecord,
  ReviewLens,
  Stop,
} from "./types";

const FINISH_PHASES: readonly FinishPhase[] = ["acceptance", "spec", "quality", "review", "gate"];

/**
 * The finish run's whole mutable state, as plain JSON.
 *
 * Everything the acpx flow reconstructed by scanning `ctx.state.steps` is a
 * named field here. That is not only simpler — the step-scanning helpers each
 * had to document whether they counted the current step (`repromptCount` did,
 * `incompleteCount` did not, and their comparisons differed by one character as
 * a result), and every new call site had to get that right again.
 *
 * Serializable by construction: no class instances, no functions, no Map/Set.
 * `nax finish` and resume-from-checkpoint are deferred (design section 7) but
 * are only cheap to add while that stays true.
 */
export interface FinishPhaseState {
  /** Times this phase's fix step has run. Capped by MAX_FIX_ATTEMPTS. */
  fixAttempts: number;
  /** Times this phase's reviewer has run. Zero for `acceptance` and `gate`. */
  reviewAttempts: number;
  /**
   * Rounds recorded for this phase, and the value written to `FinishRound.attempt`.
   *
   * One counter, incremented once per recorded round by whichever seam records
   * it. The flow had two — `commit_<phase>` wrote its fix count and
   * `route_<phase>` wrote its review count into the same field, so a real trail
   * reads 1, 1, 3, 4 and nothing downstream can order it (design F3).
   */
  rounds: number;
  /** A1: advisor rounds spent on judged findings. Optional: states and fixtures predating A1 read as 0. */
  adviseRounds?: number;
  /** A1: outcome of this phase's last recorded round (the approval precondition reads it). */
  lastOutcome?: import("./types").FinishRoundOutcome;
}

export type FinishStatus = "running" | FinishResultStatus;

/** A4: the shared review/fix loop's record for one finish. */
export interface ReviewLoopState {
  /** Review rounds run this finish (both lenses = one round). Capped by MAX_REVIEW_ROUNDS. */
  rounds: number;
  /** Merged findings from the last round, before judgment. */
  lastFindings: Finding[];
  /** Lenses with no verdict in the last round. */
  missingLenses: ReviewLens[];
  /** Judged findings carried to resolution unfixed (hold, advisor off, fallback). */
  unresolved: Finding[];
  reReviewUsed: boolean;
  /** True once a review fix round committed. Triggers the acceptance re-check. */
  committedFixes: boolean;
  /** Branch reviewer's last title / summary for the PR. */
  title?: string;
  summary?: string;
  covered: Record<ReviewLens, string[]>;
}

export interface FinishState {
  /** Bumped when a field's meaning changes, so a resumed state is rejected rather than misread. */
  version: 2;
  feature: string;
  workdir: string;
  branch: string;
  runId: string;
  /** Base ref the reviewers diff against, e.g. `origin/main`. */
  base: string;
  /** Repo-relative spec path for the review prompts. */
  specPath: string;
  status: FinishStatus;
  phases: Record<FinishPhase, FinishPhaseState>;
  /** Findings the current phase's reviewer last reported; the fix step's input. */
  findings: Finding[];
  /**
   * Gate names the last quality-gate pass ran, for the PR body's Verification
   * section. Recorded here because `runQualityGates`'s result is otherwise
   * local to the machine's loop, and `FinishOps` — which builds the body —
   * never sees it. An absent or empty list renders no gate line at all, which
   * is why a silently-unset field would have gone unnoticed.
   */
  gatesRan?: string[];
  /** Set once the draft PR is open (D7), so promote is idempotent. */
  prUrl?: string;
  /** A4: why the finish ended as a draft or failed. */
  reason?: string;
  /** A4: the resolver's decision, read by the PR context. */
  resolution?: FinishResolution;
  /** A4: set immediately before a forge call, so a throw can be told apart from a loop failure. */
  finalizing?: boolean;
  /** A4: the shared review loop's record. */
  review: ReviewLoopState;
  /** A4: SHAs of fix commits no full review round has seen yet. */
  unreviewedFixCommits: string[];
  /** A4: acceptance as last verified. */
  acceptanceFact?: AcceptanceFact;
  /** A4: gate results as last run. */
  gateFacts?: GateFact[];
  /**
   * True once any phase's fix loop produced a commit during this run.
   *
   * The signal `openOrPromotePr` gates a PR title/body rewrite on
   * (#1674 part 3): a run that only re-verified an already-green branch has
   * nothing new to describe, and must leave a human's edited description
   * alone. Per-phase `fixAttempts` does not answer this — it increments every
   * time a fix step runs, including a fixer whose commit produced no diff
   * (`commitFixes`'s `committed: false`), so counting attempts would still
   * rewrite the body on a no-op run. This flag instead mirrors the exact
   * `commit.committed` boolean `machine.ts` already computes at each of the
   * three commit sites (acceptance/review/gate loops): set true the first
   * time any of them commits, never reset, for the lifetime of one run's
   * `FinishState`.
   */
  committedThisRun: boolean;
  /** Finish A: every place a step stopped short (review lens, fix session, flow deadline, run cancel). */
  stops: Stop[];
  /** Finish A: every fix session that was set aside, in order; `handoffs[n - 1]` is handoff `n`. */
  handoffs: HandoffRecord[];
  /** Finish A: the handoff the next fix attempt for the same work should continue from. */
  pendingHandoff?: number;
  /** Finish A: the base the last fix session started from. */
  lastFixBase?: FixBase;
  /** The step the machine is in, for flow stops recorded outside a fix session. */
  step?: Stop["step"];
}

/** The caller-supplied identity fields of a fresh `FinishState`. */
export type FinishStateInit = Pick<FinishState, "feature" | "workdir" | "branch" | "runId" | "base" | "specPath">;

function zeroedReview(): ReviewLoopState {
  return {
    rounds: 0,
    lastFindings: [],
    missingLenses: [],
    unresolved: [],
    reReviewUsed: false,
    committedFixes: false,
    covered: { spec: [], quality: [] },
  };
}

function zeroedPhaseState(): FinishPhaseState {
  return { fixAttempts: 0, reviewAttempts: 0, rounds: 0 };
}

/** Builds a fresh `FinishState`: all five phases zeroed, `status: "running"`, no findings. */
export function createFinishState(init: FinishStateInit): FinishState {
  const phases = {} as Record<FinishPhase, FinishPhaseState>;
  for (const phase of FINISH_PHASES) {
    phases[phase] = zeroedPhaseState();
  }
  return {
    version: 2,
    feature: init.feature,
    workdir: init.workdir,
    branch: init.branch,
    runId: init.runId,
    base: init.base,
    specPath: init.specPath,
    status: "running",
    phases,
    findings: [],
    committedThisRun: false,
    review: zeroedReview(),
    unreviewedFixCommits: [],
    stops: [],
    handoffs: [],
  };
}

/** Serializes a `FinishState` to pretty-printed JSON. */
export function serializeFinishState(state: FinishState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Parses a `FinishState` from JSON text.
 *
 * Throws `NaxError("FINISH_STATE_UNPARSEABLE")` when `text` is not valid JSON,
 * and `NaxError("FINISH_STATE_VERSION")` when the parsed payload's `version`
 * is not `2` — a resumed state with an unrecognised shape must be rejected
 * rather than misread.
 */
export function deserializeFinishState(text: string): FinishState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new NaxError("Finish state is not valid JSON", "FINISH_STATE_UNPARSEABLE", {
      stage: "finish",
      cause: err,
    });
  }

  const version = (parsed as { version?: unknown })?.version;
  if (version !== 2) {
    throw new NaxError(`Finish state has unsupported version: ${String(version)}`, "FINISH_STATE_VERSION", {
      stage: "finish",
      version,
    });
  }

  return parsed as FinishState;
}
