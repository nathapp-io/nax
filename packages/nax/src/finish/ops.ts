/**
 * Every step of a finish that talks to an LLM or a forge.
 *
 * Defined here and implemented in the next plan so the machine is drivable —
 * and therefore testable — before a single prompt exists. The machine must
 * treat every method as able to throw: its one try/catch is what makes
 * escalate reachable from every failure path (I7).
 */
import type { A3Hint } from "./a3-hints";
import type { ReviewOutcome } from "./route";
import type { FinishState } from "./state";
import type { Finding, FindingDisposition, FinishPhase, FinishReviewOutput } from "./types";

/** What the two A4 review lenses need beyond `FinishState`: the diff's file list, PRD stories, A3 hints. */
export interface ReviewInputs {
  changed: string[];
  stories: { id: string; title: string }[];
  hints: A3Hint[];
  /** Repo-relative path of the feature's prd.json. */
  prdPath: string;
}

/** What a reviewer needs to look at one phase's diff. Opaque beyond `state` on
 * purpose — every seam a reviewer prompt needs (base, specPath, branch) is
 * already a field of `FinishState`, so this stays a thin pass-through rather
 * than a second copy of the same data. */
export interface ReviewRequest {
  state: FinishState;
}

/**
 * What a fixer needs to act on one phase's findings.
 *
 * Only the fields relevant to the phase are populated: `findings` for
 * `spec`/`quality`, `failing`/`gateOutput` for `gate`, `acceptanceOutput` for
 * `acceptance`.
 */
export interface FixRequest {
  state: FinishState;
  findings?: Finding[];
  failing?: string[];
  gateOutput?: string;
  acceptanceOutput?: string;
}

/** What a fix step did, so the commit round and commit message can report it. */
export interface FixOutcome {
  dispositions?: FindingDisposition[];
}

export interface FinishOps {
  /** A4: spec lens over the whole branch. Never throws on an unparseable reply (the op returns a missing verdict). */
  reviewSpec(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  /** A4: quality lens over the whole branch; also supplies the PR title and summary. */
  reviewBranch(state: FinishState, inputs: ReviewInputs): Promise<FinishReviewOutput>;
  /** Run a reviewer. Returns undefined only if the op produced no output at all. */
  review(phase: "spec" | "quality", req: ReviewRequest): Promise<ReviewOutcome | undefined>;
  /** Apply fixes for one phase's findings. Dispositions arrive already validated (D2.7). */
  fix(phase: FinishPhase, req: FixRequest): Promise<FixOutcome>;
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
  /** Improve the PR body prose. Optional; a run with narrative disabled omits it. */
  narrate?(state: FinishState): Promise<void>;
  /**
   * Deliver an escalation to a human. Must not throw; delivery failure is
   * reported, not raised.
   *
   * `options.push: false` suppresses the partial-fix commit and push this
   * normally does first. Only the closed-PR precondition escalation (#1674
   * part 2) passes it: nothing has run at that point, so there is nothing to
   * push, and pushing to a closed PR's branch can recreate a head branch the
   * forge deleted when the human closed it.
   */
  escalate(
    state: FinishState,
    reason: string,
    findings: Finding[],
    options?: { push?: boolean },
  ): Promise<{ url?: string; deliveryError?: string }>;
}
