import type { TemplateMode } from "@/forge";

export type { TemplateMode };

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Which finish review produced a finding (A4). */
export type ReviewLens = "spec" | "quality";

export interface Finding {
  severity: Severity;
  title: string;
  problem: string;
  fix: string;
  /**
   * Set when the reviewer marked this finding as needing a human — a spec
   * conflict or a design call with no safe mechanical fix. This replaces the
   * whole-reply `escalate` route the reviewer used to choose: escalation is a
   * property of one finding, not of the phase, so reporting a design concern no
   * longer halts the pipeline by itself.
   */
  judgment?: boolean;
  /** Why this finding needs a human; the escalation reason when it escalates. */
  judgmentReason?: string;
  /** A4: repo-relative path the finding is about, when it has one. */
  file?: string;
  /** A4: line in `file`, when the reviewer gave one. */
  line?: number;
  /**
   * A4: the review that produced it. Set by finish from the producing op, never by the model.
   * Optional only so pre-A4 `result.json` files still type-check when imported.
   */
  source?: ReviewLens;
}

/** Finish A: what an interrupted fix session says it finished, per finding. */
export interface HandoffNote {
  findings: { index: number; status: "done" | "partial" | "not-started"; files: string[]; remaining: string }[];
}

/** Finish A: an earlier set-aside fix attempt that the next attempt continues. */
export interface FixContinuation {
  note?: HandoffNote;
  files: string[];
}

/** What one A4 finish review op returns. */
export interface FinishReviewOutput {
  findings: Finding[];
  /** Repo-relative paths the reviewer says it read. Telemetry only — never routed on. */
  covered: string[];
  /** Branch review only: conventional-commit PR title. */
  title?: string;
  /** Branch review only: the PR's "What changed" prose. */
  summary?: string;
  /** Set when the op produced no parseable verdict after its retry. */
  missing?: true;
  /** Finish A: stopped by `finish.timeouts.reviewMs`; always paired with `missing`. */
  stoppedAtLimit?: true;
}

/** What the fix node did with one finding it was handed. */
export interface FindingDisposition {
  /** 1-based index into the findings list the fix prompt numbered. */
  index: number;
  disposition: "fixed" | "rejected";
  /** `file:line` pinning the current behaviour; required for a rejection. */
  evidence?: string;
  /** Set by `commit_<phase>` when the cited evidence path does not exist. */
  evidenceMissing?: boolean;
}
/** Wall-clock budgets, forwarded from `finish.timeouts` by `runFinishPhase`. */
export interface FinishTimeouts {
  acceptanceMs?: number;
  gateMs?: number;
  reviewMs?: number;
  fixMs?: number;
  flowMs?: number;
}
/** The fix-and-reverify loops, in order. `review` is the shared fix round for both review lenses. */
export type FinishPhase = "acceptance" | "spec" | "quality" | "review" | "gate";

/**
 * One completed fix round, appended to the audit trail as it happens.
 *
 * Rounds are appended at `commit_<phase>` as they happen rather than
 * reconstructed by a terminal node from `ctx.state.steps` (which does retain
 * every step's output). Appending live is what makes the trail survive a flow
 * that is killed or times out: no terminal node runs on those paths, and a
 * finish that died mid-loop is exactly when the record of what it already
 * changed on the branch matters most.
 */
/**
 * What produced a round — the difference between "a reviewer read this and
 * approved it" and "nothing read this".
 *
 * Rounds used to be appended only where a fix produced a commit, so a review
 * that passed left no record at all and was indistinguishable from a review
 * that never ran (#1507). Every phase that executes now records a round, and
 * this field says which of the five things happened.
 *
 * Optional because rounds recorded by earlier versions have no `outcome`, and
 * the PR body still has to render those without claiming more than it knows.
 */
export type FinishRoundOutcome =
  /** A reviewer reported findings and this phase's fix node ran. */
  | "fixed"
  /** A reviewer ran and reported nothing. The only value that means "approved". */
  | "passed"
  /**
   * The reviewer replied, but no verdict could be read out of it.
   *
   * Read-only history now: nothing in this module produces this outcome (the
   * reprompt path is gone), so no live path writes it. Retained because older audit trails hold
   * rounds with this outcome and a reader must still be able to render them.
   */
  | "unparseable"
  /** Read-only history, no longer emitted: handed off to a human by an explicit escalate or a cap. */
  | "escalated"
  /**
   * This phase has no reviewer at all (`gate`, `acceptance`). Distinct from
   * `passed`: an empty finding list here means "nobody looked", and rendering it
   * as "no findings" manufactures evidence of a review that does not exist.
   */
  | "no-reviewer"
  /**
   * A re-review was owed and deliberately skipped.
   *
   * **No longer emitted.** It described the `gate` → `tests-only` route, which
   * skipped `review_quality` as a cost tradeoff; #1510 closed that hole, so
   * every committed gate fix is now re-reviewed and nothing writes this.
   *
   * Retained because the audit trail is read, not just written: a project that
   * ran an earlier nax can hold rounds carrying this outcome, and dropping it
   * from the union would make those unrenderable. Do not reuse the name for a
   * new meaning — a reader hitting it in an old artifact must still be told
   * what it meant when it was written.
   */
  | "review-skipped"
  /** Read-only history, no longer emitted: the reviewer replied with findings but
   * skipped a required audit section, so the verdict was not acted on. */
  | "incomplete"
  /** A4: a review lens produced no verdict after its retry. */
  | "missing"
  /** A1: the advisor ruled on every judged finding and nothing was left to fix;
   * the phase re-reviews. Not an approval. */
  | "advised";

export interface FinishRound {
  ts: string;
  phase: FinishPhase;
  /** 1-based; the Nth time this phase's fix node has run. */
  attempt: number;
  /** True when the fix produced a commit; false when it changed nothing. */
  committed: boolean;
  /** What produced this round; absent on rounds written before it existed. */
  outcome?: FinishRoundOutcome;
  /** Reviewer findings this round set out to fix (spec/quality phases). */
  findings: Finding[];
  /** Gate commands that were red this round (gate phase). */
  failing?: string[];
  /**
   * The successor this round's commit routed to — `changed` / `tests-only` /
   * `unchanged` for `gate`, `changed` / `unchanged` elsewhere.
   *
   * Recorded because `outcome` stopped carrying it. Until #1510 a tests-only
   * gate fix was the only round writing `review-skipped`, so the outcome
   * doubled as the classification; now every committed gate fix is reviewed
   * and writes `no-reviewer`, which would leave "what did this fix touch?"
   * unanswerable from the trail. That question is the input to deciding
   * whether the re-review ever needs a cheaper, test-scoped form, so it has to
   * survive the round it was computed in.
   */
  route?: string;
  /**
   * `HEAD` SHA after this round's commit (set only when `committed`); absent
   * on no-op rounds so a reader can distinguish "no commit" from "record lost".
   * Lets "Fixed in `<sha>`" be reconstructed from the audit trail alone, rather
   * than by matching round timestamps against `git log`.
   */
  sha?: string;
  /** What the fixer did with each finding it was handed (spec/quality phases). */
  dispositions?: FindingDisposition[];
  /** A1: advisor decisions applied in this round (absent when the advisor did not run). */
  advice?: { decisionId: string; optionId: string; reused: boolean }[];
}

/**
 * How the repo's own PR/MR template is honoured when composing the body.
 * Absent (and absent fields) mean the defaults in `pr-template-merge.ts`.
 */
export interface FinishPrBodySettings {
  /** `merge` (default) · `strict` (keep unfillable headings, empty) · `ignore`. */
  template?: TemplateMode;
  /** Normalised template heading → body-section key, layered over the defaults. */
  sectionMap?: Record<string, string>;
}
/** Result-level status. State adds `running` (see `FinishState.status`). */
export type FinishResultStatus =
  | "opened"
  | "promoted"
  | "already-ready"
  | "draft"
  | "local-only"
  | "failed"
  | "nothing-to-finish";

/** Whether acceptance was verified green at the end of the finish. */
export type AcceptanceFact = "green" | "red" | "unverified" | "not-configured";

/** One quality gate's end-of-finish result. */
export interface GateFact {
  name: string;
  status: "green" | "red";
  excerpt?: string;
}

/** The end-of-run facts the resolver turns into `ready | draft`. Computed by the resolver (A4 Task 10). */
export interface ResolutionFacts {
  findingsOpen: Finding[];
  acceptance: AcceptanceFact;
  gates: GateFact[];
  reviewsMissing: ReviewLens[];
  unreviewedFixCommits: string[];
  coverage: Record<ReviewLens, number | null>;
  fixRounds: number;
}

/** What the resolver decided, kept on the state so the PR context can read it. */
export interface FinishResolution {
  outcome: "ready" | "draft";
  reason?: string;
  facts: ResolutionFacts;
  acceptedResidue: Finding[];
}

export interface FinishResult {
  feature: string;
  status: FinishResultStatus;
  /** A4: `ready | draft | failed`. No forge is a status (`local-only`), not an outcome. */
  outcome?: "ready" | "draft" | "failed";
  /** A4: why the outcome is not a clean `ready`, or why the finish failed. */
  reason?: string;
  /** A4: the facts behind the outcome. */
  facts?: ResolutionFacts;
  /** A4: judged findings accepted as residue on a ready PR. */
  acceptedResidue?: Finding[];
  /**
   * HEAD sha at the moment this result was written — the finish ledger's key
   * (#1674 part 1, `./audit`'s `writeResult`). Set on every path that reaches
   * a terminal outcome after the machine has actually run (`finalizeResult`,
   * `failedResult`); absent on a preflight `nothing-to-finish`, which never
   * gets far enough to have one worth recording.
   */
  headSha?: string;
  /** The branch finish ran on — the ledger's other half of its key, alongside `headSha`. */
  branch?: string;
  url?: string;
  /** Open findings on a draft PR. */
  findings?: Finding[];
  /**
   * Every fix round the flow ran, on *all* terminal statuses — not just
   * escalations. A successful finish that took four rounds to get there is the
   * case worth auditing (it says the run's own review gates missed four
   * defects), and it was previously the one case that recorded nothing.
   */
  rounds?: FinishRound[];
  /**
   * Set only when `FinishContext.route` was `"already-finished"` (#1674 part
   * 1): this result is a ledger skip, not a fresh preflight outcome, even
   * though its `status` reuses `"nothing-to-finish"`. `runFinishPhase` reads
   * this to report `postRun.finish.status: "skipped"` rather than `"passed"`
   * on `status.json` — the two are different claims ("there was truly
   * nothing to do" vs "this exact commit was already finished").
   *
   * `"pr-merged"` (#1674 part 2) is the same kind of claim from the other
   * short-circuit: the branch's PR was already merged, so the machine stood
   * down before running anything. Both reuse `status: "nothing-to-finish"`,
   * and both report `"skipped"` rather than `"passed"`.
   */
  skipReason?: "already-finished" | "pr-merged";
}

/** Result of running the feature's acceptance-test gate. */
export interface AcceptanceGateResult {
  /** Every group that ran exited 0. Says nothing about groups that could not run. */
  passed: boolean;
  ran: number;
  /** Packages whose acceptance test the resolver expected but which is absent on disk. */
  missing: string[];
  output: string;
}

/** Result of running the repo's configured quality gates (lint, typecheck, etc.). */
export interface QualityGateResult {
  passed: boolean;
  /** Gate names that actually ran; empty means nothing was configured. */
  ran: string[];
  failing: string[];
  output: string;
}

/** Finish A §4.1: one pre-existing untracked file at fix-session start. */
export interface UntrackedEntry {
  path: string;
  size: number;
  mtimeMs: number;
  saved: boolean;
}
export interface UntrackedSnapshot {
  dir: string;
  files: UntrackedEntry[];
}
/** Finish A §4.1: the state a fix session started from. */
export interface FixBase {
  baseSha: string;
  headSha: string;
  untrackedBefore: string[];
  untrackedSnapshot?: UntrackedSnapshot;
}
/** Finish A §3.3: one place a finish stopped short of its work, for the PR body and the result. */
export interface Stop {
  kind: "review" | "fix" | "flow" | "run";
  step?: "acceptance" | "review" | "gate" | "resolve";
  phase?: "acceptance" | "gate" | "review";
  lens?: ReviewLens;
  round?: number;
  at: string;
  limitMs: number;
  handoff?: number;
  findings?: number;
}
export type HandoffLimit = "fix" | "flow" | "run" | "error";
/** Finish A §4.2: `meta.json` of a set-aside handoff. */
export interface HandoffRecord {
  n: number;
  dir: string;
  phase: "acceptance" | "gate" | "review";
  limit: HandoffLimit;
  baseSha: string;
  headSha: string;
  findingIds: string[];
  newUntracked: string[];
  changedPaths: string[];
  stoppedAt: string;
  hasNote: boolean;
  patchSaved: boolean;
  restored: boolean;
  consumed: boolean;
  reapplied?: boolean;
  /** Pre-existing untracked files the session changed: put back from the snapshot. */
  untrackedRestored: string[];
  /** Pre-existing untracked files the session changed that had no snapshot (over the cap): moved into the handoff. */
  untrackedMovedAside: string[];
  /** Pre-existing untracked files the session changed that could not be handled safely; left as the session left them. */
  untrackedFailed: string[];
}
