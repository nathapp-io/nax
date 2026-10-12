/**
 * Every step of a finish that talks to an LLM or a forge.
 *
 * Defined here so the machine is drivable -- and therefore testable -- against
 * stubs. The machine treats every method as able to throw: its one try/catch
 * routes any throw to a draft PR, or to `failed` when the forge call itself threw.
 */
import type { A3Hint } from "./a3-hints";
import type { FinishState } from "./state";
import type { Finding, FindingDisposition, FinishReviewOutput, FixContinuation, HandoffNote } from "./types";

/** What the two A4 review lenses need beyond `FinishState`: the diff's file list, PRD stories, A3 hints. */
export interface ReviewInputs {
  changed: string[];
  stories: { id: string; title: string }[];
  hints: A3Hint[];
  /** Repo-relative path of the feature's prd.json. */
  prdPath: string;
}

/** The three fix sessions: the shared review fix, the gate fix and the acceptance fix. */
export type FixPhase = "acceptance" | "gate" | "review";

/**
 * What a fixer needs to act on one phase's findings.
 *
 * Only the fields relevant to the phase are populated: `findings` for
 * `review`, `failing`/`gateOutput` for `gate`, `acceptanceOutput` for
 * `acceptance`. `findings` arrive spec-source first: the fix prompt numbers
 * them in that order and the returned dispositions index into it.
 */
export interface FixRequest {
  state: FinishState;
  findings?: Finding[];
  failing?: string[];
  gateOutput?: string;
  acceptanceOutput?: string;
  /** Finish A: soft interrupt (phase signal + fixMs). The op's own (hard) signal is the run's. */
  interrupt?: AbortSignal;
  /** Finish A: a previous stopped session's work to continue from. */
  continuation?: FixContinuation;
  /** Finish B 6.2: acceptance test files a review or gate fixer must not edit. */
  acceptancePaths?: string[];
}

/** What a fix step did, so the commit round and commit message can report it. */
export interface FixOutcome {
  dispositions?: FindingDisposition[];
  /** Finish A: the fix turn was soft-interrupted by its step or the phase. */
  interrupted?: true;
  /** Finish A: the same session's handoff note, when it gave one. */
  handoffNote?: HandoffNote;
}

export interface FinishOps {
  /** A4: spec lens over the whole branch. Never throws on an unparseable reply (the op returns a missing verdict). */
  reviewSpec(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  /** A4: quality lens over the whole branch; also supplies the PR title and summary. */
  reviewBranch(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  /** Apply fixes for one phase's findings. Dispositions arrive already validated (D2.7). */
  fix(phase: FixPhase, req: FixRequest): Promise<FixOutcome>;
  /** Open a draft PR after the acceptance gate first passes (D7). Idempotent via `hasOpenPr`. */
  openDraftPr(state: FinishState): Promise<{ url: string } | null>;
  /** Push, then promote the draft to ready. Returns the terminal status. */
  promotePr(
    state: FinishState,
  ): Promise<{ status: "opened" | "promoted" | "already-ready" | "local-only"; url?: string }>;
  /**
   * A4: push, then keep the PR draft: update its title and body, or create it as a draft.
   * `already-ready` when a human had already marked the PR ready (it is not demoted).
   */
  finalizeDraftPr(state: FinishState): Promise<{ status: "draft" | "already-ready" | "local-only"; url?: string }>;
}
