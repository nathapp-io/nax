import { NaxError } from "../errors";
import type { Finding, FinishPhase } from "./types";

const FINISH_PHASES: readonly FinishPhase[] = ["acceptance", "spec", "quality", "gate"];

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
  /** Times a review of this phase was sent back for missing evidence. Capped by MAX_INCOMPLETE_ATTEMPTS. */
  incompleteAttempts: number;
  /**
   * Rounds recorded for this phase, and the value written to `FinishRound.attempt`.
   *
   * One counter, incremented once per recorded round by whichever seam records
   * it. The flow had two — `commit_<phase>` wrote its fix count and
   * `route_<phase>` wrote its review count into the same field, so a real trail
   * reads 1, 1, 3, 4 and nothing downstream can order it (design F3).
   */
  rounds: number;
  /**
   * The commit this phase's next review diffs from — the `shaBefore` of the
   * first commit that landed after its last verdict, not the latest one.
   *
   * The acceptance loop can commit between a spec fix and its re-review (I8),
   * so a window anchored on the most recent commit would silently exclude the
   * fix that triggered it. Unset means "no commit since the last verdict", and
   * the reviewer reads the full branch diff.
   */
  reviewSince?: string;
  /**
   * Why this phase's last review was sent back, so the retry is told what it
   * skipped. Cleared when a review runs, because it describes the previous
   * attempt only.
   */
  reviewGaps?: string[];
}

export type FinishStatus = "running" | "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";

export interface FinishState {
  /** Bumped when a field's meaning changes, so a resumed state is rejected rather than misread. */
  version: 1;
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
  escalationReason?: string;
}

/** The caller-supplied identity fields of a fresh `FinishState`. */
export type FinishStateInit = Pick<FinishState, "feature" | "workdir" | "branch" | "runId" | "base" | "specPath">;

function zeroedPhaseState(): FinishPhaseState {
  return { fixAttempts: 0, reviewAttempts: 0, incompleteAttempts: 0, rounds: 0 };
}

/** Builds a fresh `FinishState`: all four phases zeroed, `status: "running"`, no findings. */
export function createFinishState(init: FinishStateInit): FinishState {
  const phases = {} as Record<FinishPhase, FinishPhaseState>;
  for (const phase of FINISH_PHASES) {
    phases[phase] = zeroedPhaseState();
  }
  return {
    version: 1,
    feature: init.feature,
    workdir: init.workdir,
    branch: init.branch,
    runId: init.runId,
    base: init.base,
    specPath: init.specPath,
    status: "running",
    phases,
    findings: [],
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
 * is not `1` — a resumed state with an unrecognised shape must be rejected
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
  if (version !== 1) {
    throw new NaxError(`Finish state has unsupported version: ${String(version)}`, "FINISH_STATE_VERSION", {
      stage: "finish",
      version,
    });
  }

  return parsed as FinishState;
}
