/**
 * US-004: the evidence-only review of a repair's committed diff.
 *
 * A repair commits *after* the branch re-review, so the tree the branch review read is not the tree
 * the run publishes — the repair's own diff would reach the PR unreviewed. This module reads HEAD
 * around one repair session and, when the repair moved it, asks the branch re-review for one verdict
 * over that diff. The verdict is a record line (`repairReviews`) and evidence for the approval
 * advisor; it opens no fix round.
 *
 * `gateRepairStep` calls it, and US-005's `ciRepairStep` calls it too, so the behaviour lives here
 * once. It lives outside `feature-steps.ts` for the same reason `feature-step-helpers.ts` does:
 * `ci-repair-steps.ts` must not import `feature-steps.ts`, which imports it back.
 *
 * The repair session always runs exactly as it does without a review: a HEAD read that throws is a
 * ledger note ([`SKIPPED_HEAD`]) and no review, never a lost repair.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { BranchFixOutcome } from "./branch-fix";
import type { FeatureEnv } from "./feature-machine";
import { NO_MIRROR } from "./feature-step-helpers";
import { ledgerText } from "./ledger";
import type { ReviewOutcome } from "./story-review";
import type { ReReviewVerdict, WorkflowFeatureRecord, WorkflowFinding, WorkflowFindingDraft } from "./types";

/** The two repair nodes, as their record lines name them. */
export type RepairReviewKind = "gate repair" | "CI repair";

/** Why a repair diff was not reviewed when nax could not even read HEAD around the repair. */
export const SKIPPED_HEAD = "could not read HEAD";

/** The wired review, as the helper sees it — `undefined` means the run reviews nothing. */
type RepairReviewStep = NonNullable<FeatureEnv["steps"]["repairReview"]>;

/** The `repairReviews` lines a step adds: nothing at all when nothing was reviewed. */
export type RepairReviewPatch = Partial<Pick<WorkflowFeatureRecord, "repairReviews">>;

/** Everything one repair round's review needs. */
export interface RepairReviewInput {
  readonly kind: RepairReviewKind;
  /** The repair round, as the step counts it — the same number its own ledger line names. */
  readonly round: number;
  /** The repair's own findings: what the review is asked to check the diff against. */
  readonly findings: readonly WorkflowFinding[];
  /** The repair session itself. It runs whatever the HEAD reads return. */
  readonly run: () => Promise<BranchFixOutcome>;
  /**
   * The `<kind> r<N> ...` lines the record already carries, in order. Passed in because `env.record`
   * is the record the *run* started with (the step graph hands each node the current one), so a
   * second round would otherwise replace the first round's line instead of appending to it.
   */
  readonly history: readonly string[];
}

/** What the caller keeps: its own repair outcome, plus the record lines to add. */
export interface RepairReviewResult {
  readonly outcome: BranchFixOutcome;
  readonly patch: RepairReviewPatch;
}

/** `<kind> r<N>` — the prefix every line of a round shares. */
const labelOf = (input: RepairReviewInput): string => `${input.kind} r${input.round}`;

/**
 * HEAD, fail-soft for this use only: an unreadable HEAD is a skipped review, and never the repair's
 * own failure, so it is caught here rather than thrown at the step.
 */
async function readHead(env: FeatureEnv): Promise<string | undefined> {
  try {
    return await env.steps.head();
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Could not read HEAD around a repair; its diff is not re-reviewed", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return undefined;
  }
}

/**
 * The review itself, fail-soft. A throw here comes after the repair already committed, so losing the
 * repair's outcome to it would be the worse answer: it becomes a `review skipped` line that names
 * the error, exactly as a review op that timed out reads.
 */
async function askReview(
  review: RepairReviewStep,
  findings: readonly WorkflowFinding[],
  base: string,
): Promise<ReviewOutcome<ReReviewVerdict>> {
  try {
    return await review(findings, base);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "The repair diff's review threw; the repair stands as its session left it", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return { ran: false, why: errorMessage(err) };
  }
}

/** `G1 addressed`, and a residual's own word for a finding only partly fixed. */
function statusText(entry: ReReviewVerdict["verdicts"][number]): string {
  if (entry.residual) return "PARTIAL";
  return entry.addressed ? "addressed" : "NOT addressed";
}

/** `[<severity>] <file>: <issue>`, or `[<severity>] <issue>` for a finding that names no file. */
function newFindingText(finding: WorkflowFindingDraft): string {
  return finding.file
    ? `[${finding.severity}] ${finding.file}: ${finding.issue}`
    : `[${finding.severity}] ${finding.issue}`;
}

/**
 * The verdict half of a `reviewed` line: one `<id> <status>` per entry, then the new findings, each
 * part separated the way the step ledger already reads (`G1 addressed, G2 PARTIAL; new: …`).
 */
function verdictText(verdict: ReReviewVerdict): string {
  const entries = verdict.verdicts.map((entry) => `${entry.id} ${statusText(entry)}`).join(", ");
  const added = verdict.newFindings.map(newFindingText).join("; ");
  return [entries, added === "" ? "" : `new: ${added}`].filter((part) => part !== "").join("; ");
}

/** The one line a round's review adds to the record. */
async function reviewLine(review: RepairReviewStep, input: RepairReviewInput, base: string): Promise<string> {
  const label = labelOf(input);
  const outcome = await askReview(review, input.findings, base);
  return outcome.ran ? `${label} reviewed: ${verdictText(outcome.verdict)}` : `${label} review skipped: ${outcome.why}`;
}

/** A HEAD read that threw: no review, no record line, and the ledger says why. */
async function noteSkippedHead(env: FeatureEnv, input: RepairReviewInput): Promise<RepairReviewPatch> {
  await env.sink.ledger(ledgerText.note(`${labelOf(input)} review skipped: ${SKIPPED_HEAD}`), NO_MIRROR);
  return {};
}

/**
 * Run one repair round and review the diff it left behind.
 *
 * No wired review (or no finding to check against) means today's repair behaviour exactly: no HEAD
 * read, no record line. Otherwise HEAD is read before the repair and again after it; a repair that
 * failed, or that moved nothing, is not reviewed and adds no line. Only a moved HEAD is reviewed,
 * once, and its verdict appends one line to the record's `repairReviews`.
 */
export async function reviewRepairDiff(env: FeatureEnv, input: RepairReviewInput): Promise<RepairReviewResult> {
  const review = env.steps.repairReview;
  if (review === undefined || input.findings.length === 0) return { outcome: await input.run(), patch: {} };
  const before = await readHead(env);
  const outcome = await input.run();
  // A failed session reviews nothing: there is no reply to hold a review against.
  if (outcome.failure) return { outcome, patch: {} };
  // One unreadable HEAD — either side of the repair — skips the review, and never the repair.
  if (before === undefined) return { outcome, patch: await noteSkippedHead(env, input) };
  const after = await readHead(env);
  if (after === undefined) return { outcome, patch: await noteSkippedHead(env, input) };
  // A repair that committed nothing leaves the reviewed tree as it was: nothing new to review.
  if (after === before) return { outcome, patch: {} };
  const line = await reviewLine(review, input, before);
  return { outcome, patch: { repairReviews: [...input.history, line] } };
}
