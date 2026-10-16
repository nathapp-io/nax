/**
 * The feature workflow (spec §7) as a state machine. Pure orchestration over injected
 * steps, persisted after every step (P4-R1), so a crash resumes at `record.step`.
 * One branch review, up to `workflow.maxBranchFixRounds` fix passes (#2496, nax#2547) with one scoped
 * re-review each, one adjudication, then the final gates with up to `workflow.finalGateRepairRounds`
 * repair passes when the branch fix turned green gates red (nax#2548). Past `execution.costLimit`
 * no agent step runs: the machine goes to the final gates and publishes a draft (nax#2550).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { WORKFLOW_DEFAULTS } from "@/config";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { FEATURE_SCOPE } from "./advisor-live";
import { describeUnread, featurePassed } from "./approval";
import type { BranchFixOutcome } from "./branch-fix";
import { dropKnownRestatements, type FeatureLimits, nextBranchFixRound } from "./branch-fix-rounds";
import type { BranchReviewFacts } from "./branch-review";
import type { PublishOutcome } from "./finalize";
import { type LedgerWriteOptions, ledgerText } from "./ledger";
import type { LedgerItem } from "./ledger-items";
import { absorbReReviewVerdict } from "./re-review-absorb";
import type { RepoGateRun } from "./repo-gates";
import { type RestatedMinor, splitRestatedMinors } from "./restated-minors";
import { describeFindings, type StepModel, startStep } from "./run-log";
import type { ReviewOutcome } from "./story-review";
import type {
  BranchReviewVerdict,
  FeatureStep,
  MinorItem,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
} from "./types";

export interface FeatureSteps {
  repoGates(): Promise<RepoGateRun>;
  branchReview(seed: string, facts: BranchReviewFacts): Promise<ReviewOutcome<BranchReviewVerdict>>;
  branchFix(findings: readonly WorkflowFinding[]): Promise<BranchFixOutcome>;
  branchReReview(findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
  adjudicate(items: readonly WorkflowFinding[]): Promise<readonly WorkflowRuling[]>;
  publish(record: WorkflowFeatureRecord): Promise<PublishOutcome>;
  head(): Promise<string>;
  /** Repo-rooted paths changed between `base` and HEAD. Throws on a git failure. */
  changedFiles(base: string): Promise<readonly string[]>;
  /** The model a step will run on, for its start line (nax#2491 P6). Optional: absent names none. */
  modelFor?(step: "branch-review" | "branch-fix" | "branch-rereview"): StepModel | undefined;
  /**
   * US-005: the ids of the trusted ledger decisions flagged for a human, in ledger order.
   * Optional: absent means the run collects nothing and the record keeps no ids.
   */
  flaggedDecisions?(): Promise<readonly string[]>;
}

export interface FeatureSink {
  update(record: WorkflowFeatureRecord): Promise<void>;
  ledger(text: string, options?: LedgerWriteOptions): Promise<void>;
  step(step: FeatureStep, record: WorkflowFeatureRecord): void;
  /** Writes a review artifact into the run dir. Best effort: never throws. */
  artifact(name: string, value: unknown): Promise<void>;
}

export interface FeatureFacts {
  readonly stories: readonly StorySummary[];
  readonly parked: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
}

export interface FeatureEnv {
  readonly steps: FeatureSteps;
  readonly sink: FeatureSink;
  readonly facts: FeatureFacts;
  readonly record: WorkflowFeatureRecord;
  readonly aborted: () => boolean;
  /** nax#2550: the run's `execution.costLimit` check, read before every agent step; absent = no limit. */
  readonly costExceeded?: () => boolean;
  readonly now: () => number;
  /** The round caps; absent reads as the `workflow` schema defaults. */
  readonly limits?: FeatureLimits;
}

export type { FeatureLimits };

const DEFAULT_LIMITS: FeatureLimits = {
  maxBranchFixRounds: WORKFLOW_DEFAULTS.maxBranchFixRounds,
  finalGateRepairRounds: WORKFLOW_DEFAULTS.finalGateRepairRounds,
};
const limitsOf = (env: FeatureEnv): FeatureLimits => env.limits ?? DEFAULT_LIMITS;

type Patch = Partial<WorkflowFeatureRecord>;
type StepFn = (env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<Patch>;

/** The step line in the log already says it; ledger.md still records it. */
const NO_MIRROR: LedgerWriteOptions = { mirror: false };

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";
const minorIssues = (drafts: readonly WorkflowFindingDraft[]): string[] =>
  drafts.filter((f) => !isBlocking(f)).map((f) => f.issue);

/** A dropped restatement still leaves a trace, in case the copy was a new minor after all. */
async function noteRestated(env: FeatureEnv, dropped: readonly RestatedMinor[]): Promise<void> {
  for (const d of dropped)
    await env.sink.ledger(ledgerText.note(`restated deferred minor ${d.id} dropped: ${d.issue}`));
}

function assign(
  rec: WorkflowFeatureRecord,
  drafts: readonly WorkflowFindingDraft[],
): { findings: WorkflowFinding[]; nextFindingId: number } {
  const findings = drafts.map((d, i) => ({ ...d, id: `B${rec.nextFindingId + i}` }));
  return { findings, nextFindingId: rec.nextFindingId + drafts.length };
}

function minorFinding(m: MinorItem): WorkflowFinding {
  return { id: m.id, kind: "quality", severity: "minor", issue: `${m.storyId}: ${m.text}` };
}

function fixNowMinors(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  return rec.minors.filter((m) => m.triage === "fix-now").map(minorFinding);
}

const fixRoundsOf = (rec: WorkflowFeatureRecord): number => rec.fixRounds ?? (rec.fixRan ? 1 : 0);
/** Rounds 2+ fix only `fixTargets`; round 1 fixes the whole review. */
const isFollowUpRound = (rec: WorkflowFeatureRecord): boolean =>
  fixRoundsOf(rec) >= 1 && (rec.fixTargets?.length ?? 0) > 0;
const roundLabel = (base: string, round: number): string => (round > 1 ? `${base} r${round}` : base);

function roundTargets(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  const ids = new Set(rec.fixTargets ?? []);
  return rec.reviewOpen.filter((f) => ids.has(f.id));
}

function storyNote(s: StorySummary): string | undefined {
  const parts = [s.state === "complete" ? undefined : s.reason, s.unreviewed ? "unreviewed" : undefined];
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function reviewFacts(env: FeatureEnv, rec: WorkflowFeatureRecord): BranchReviewFacts {
  return {
    stories: env.facts.stories.map((s) => {
      const note = storyNote(s);
      return { id: s.id, state: s.state, ...(note ? { note } : {}) };
    }),
    minors: rec.minors.map((m) => ({ id: m.id, storyId: m.storyId, text: m.text })),
    parked: env.facts.parked,
    cannotVerify: env.facts.cannotVerify,
    gateFindings: rec.gateFindings,
    // US-006 (nax#2527): a record with no repo gates yet reads as "not run", never as green.
    repoGates: rec.repoGates ?? { ran: [], failing: [] },
  };
}

/** Wall-clock timing for the log only; the record's `timings` keep using `env.now`. */
const featureStep = (label: string, announce = true, bare = false, model?: StepModel) =>
  startStep(FEATURE_SCOPE, label, { announce, bare, model });

const gatesText = (failing: readonly string[]): string =>
  failing.length > 0 ? `red (${failing.join(", ")})` : "green";

async function repoGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const log = featureStep("repo-gates", false, true);
  const run = await env.steps.repoGates();
  log.done(gatesText(run.summary.failing));
  const gateOpen: WorkflowFindingDraft[] = env.facts.stories
    .filter((s) => s.state === "complete-gate-open")
    .map((s) => ({
      kind: "gate",
      severity: "important",
      issue: `${s.id} ended with a red gate (${s.reason ?? "gate red"}). Make its gates green.`,
    }));
  const { findings, nextFindingId } = assign(rec, [...run.findings, ...gateOpen]);
  if (run.summary.failing.length > 0) {
    await env.sink.ledger(ledgerText.note(`repo gates red: ${run.summary.failing.join(", ")}`), NO_MIRROR);
  }
  return { repoGates: run.summary, gateFindings: findings, nextFindingId, step: "branch-review" };
}

/**
 * nax#2550: `quality: "changes"` with no blocking finding is not a clean review. Mirrors
 * `parseStoryReviewReply`, which adds a synthetic spec finding to `spec: "fail"` with none, so the
 * reviewer's verdict always leaves something for the fix pass and the adjudication to act on.
 */
const QUALITY_CHANGES_ISSUE = "quality: reviewer reported changes without a finding";
function withQualityFloor(verdict: BranchReviewVerdict): WorkflowFindingDraft[] {
  const blocking = verdict.findings.filter(isBlocking);
  if (verdict.quality !== "changes" || blocking.length > 0) return blocking;
  return [{ kind: "quality", severity: "important", issue: QUALITY_CHANGES_ISSUE }];
}

async function branchReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.seed) {
    featureStep("branch-review", false).done("skipped (no seed)");
    await env.sink.ledger(ledgerText.reviewSkipped("branch review: no seed"), NO_MIRROR);
    return { reviewRan: false, step: "branch-fix" };
  }
  const log = featureStep("branch-review", true, false, env.steps.modelFor?.("branch-review"));
  const out = await env.steps.branchReview(rec.seed, reviewFacts(env, rec));
  if (!out.ran) {
    log.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`branch review: ${out.why}`), NO_MIRROR);
    return { reviewRan: false, step: "branch-fix" };
  }
  for (const item of out.verdict.cannotVerify) await env.sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
  // US-003: the files the verdict did not read. Nothing else records them — the step line names the
  // findings, not the coverage — so the note is mirrored to the run log as well, in the same words
  // `publish` uses for the reason that keeps the PR a draft.
  const unread = out.verdict.unreadFiles ?? [];
  if (unread.length > 0) await env.sink.ledger(ledgerText.note(describeUnread(unread)));
  const triage = new Map(out.verdict.minorTriage.map((t) => [t.id, t.decision]));
  const restated = splitRestatedMinors(out.verdict.findings, rec.minors);
  await noteRestated(env, restated.dropped);
  const { findings, nextFindingId } = assign(rec, withQualityFloor(out.verdict));
  const minors = out.verdict.findings.filter((f) => !isBlocking(f));
  // #2496: written here, after assign(), so the file and result.json name findings the same way.
  await env.sink.artifact("branch-review.json", { ...out.verdict, findings: [...findings, ...minors] });
  log.done(`spec ${out.verdict.spec}, quality ${out.verdict.quality} - ${describeFindings([...findings, ...minors])}`);
  return {
    reviewRan: true,
    cannotVerify: out.verdict.cannotVerify,
    ...(unread.length > 0 ? { reviewUnread: unread } : {}),
    reviewOpen: findings,
    nextFindingId,
    minors: rec.minors.map((m) => ({ ...m, triage: triage.get(m.id) ?? "leave" })),
    newMinors: [...rec.newMinors, ...minorIssues(restated.kept)],
    step: "branch-fix",
  };
}

async function branchFixStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const round = fixRoundsOf(rec) + 1;
  const toFix = isFollowUpRound(rec)
    ? roundTargets(rec)
    : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { step: "branch-rereview" };
  const max = limitsOf(env).maxBranchFixRounds;
  if (round > max) {
    // A resume can find a cap lowered under a pending round; the cap wins.
    const why =
      max === 0 ? "workflow.maxBranchFixRounds is 0" : `round ${round} is past workflow.maxBranchFixRounds (${max})`;
    await env.sink.ledger(ledgerText.note(`branch fix skipped: ${why}`), NO_MIRROR);
    return { step: "adjudicate" };
  }
  // A follow-up round keeps round 1's base, so its re-review sees the whole fix, not just the last edit.
  const fixBase = round > 1 && rec.fixBase ? rec.fixBase : await readHeadSoft(env);
  if (!fixBase) {
    // nax#2550: no base means no re-review of the fix, so no fix runs; the findings go to adjudication
    // as with a round cap, and the run goes on instead of losing the feature workflow to a git blip.
    await env.sink.ledger(ledgerText.note("branch fix skipped: HEAD could not be read"), NO_MIRROR);
    return { step: "adjudicate" };
  }
  await env.sink.ledger(
    ledgerText.note(
      `${roundLabel("branch fix", round)}: ${toFix.length} item(s): ${toFix.map((f) => f.id).join(", ")}`,
    ),
    NO_MIRROR,
  );
  const log = featureStep(roundLabel("branch-fix", round), true, false, env.steps.modelFor?.("branch-fix"));
  const out = await env.steps.branchFix(toFix);
  log.done(`${toFix.map((f) => f.id).join(" ")}${out.failure ? ` (session failed: ${out.failure})` : ""}`);
  if (out.failure) await env.sink.ledger(ledgerText.note(`branch fix session failed: ${out.failure}`), NO_MIRROR);
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the branch fix's edits"));
  if (out.dirty) await env.sink.ledger(ledgerText.note("branch fix left uncommitted edits: the auto-commit failed"));
  return { fixBase, fixRan: true, fixRounds: round, step: "branch-rereview" };
}

/**
 * US-004 (nax#2524): one line per group of verdicts. The groups are the same as before — addressed,
 * then the open ones — with a `PARTIAL` group between them so a residual keeps its own id in plain
 * sight; with no residual in the verdicts the text is exactly what it always was.
 */
function reReviewText(input: {
  readonly items: readonly WorkflowFinding[];
  readonly verdicts: ReReviewVerdict["verdicts"];
  readonly stillOpen: ReadonlySet<string>;
  readonly added: readonly WorkflowFinding[];
  readonly minorsLeft: number;
}): string {
  const residuals = new Set(input.verdicts.filter((v) => v.residual).map((v) => v.id));
  const ids = (open: boolean, partial: boolean): string[] =>
    input.items.filter((f) => input.stillOpen.has(f.id) === open && residuals.has(f.id) === partial).map((f) => f.id);
  const parts = [
    ...(ids(false, false).length > 0 ? [`${ids(false, false).join(" ")} addressed`] : []),
    ...(ids(true, true).length > 0 ? [`${ids(true, true).join(" ")} PARTIAL`] : []),
    ...(ids(true, false).length > 0 ? [`${ids(true, false).join(" ")} NOT addressed`] : []),
    ...(input.added.length > 0 ? [`new: ${describeFindings(input.added)}`] : []),
  ];
  return `${parts.join(", ")}; minors left: ${input.minorsLeft}`;
}

async function branchReReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const round = fixRoundsOf(rec);
  const followUp = isFollowUpRound(rec);
  const items = followUp ? roundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)];
  if (items.length === 0 || !rec.fixBase) return { step: "adjudicate" };
  const log = featureStep(roundLabel("branch-rereview", round), true, false, env.steps.modelFor?.("branch-rereview"));
  const out = await env.steps.branchReReview(items, rec.fixBase);
  if (!out.ran) {
    log.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`branch re-review: ${out.why}`), NO_MIRROR);
    // nax#2550: the fix commits stay unreviewed, and `publish` must say so (a draft, not a ready PR).
    return { reReviewSkipped: true, step: "adjudicate" };
  }
  // Fail closed: an item the verdicts do not mark addressed stays open, omitted or not.
  const addressed = new Set(out.verdict.verdicts.filter((v) => v.addressed).map((v) => v.id));
  const stillOpen = new Set(items.map((f) => f.id).filter((id) => !addressed.has(id)));
  // US-004: only the review findings are absorbed — the fix-now minors keep their own triage handling.
  const absorbedRaw = absorbReReviewVerdict(rec.reviewOpen, out.verdict);
  const absorbed = { ...absorbedRaw, newDrafts: dropKnownRestatements(absorbedRaw.newDrafts, absorbedRaw.open) };
  const { findings, nextFindingId } = assign(rec, absorbed.newDrafts.filter(isBlocking));
  await env.sink.artifact(round > 1 ? `branch-rereview-r${round}.json` : "branch-rereview.json", {
    ...out.verdict,
    newFindings: [...findings, ...absorbed.newDrafts.filter((f) => !isBlocking(f))],
  });
  const minors = rec.minors.map((m) =>
    m.triage === "fix-now" && stillOpen.has(m.id) ? { ...m, triage: "leave" as const } : m,
  );
  // The re-reviewer was shown only the fix-now minors; a "leave" id in its reply is its own numbering.
  const restated = splitRestatedMinors(
    absorbed.newDrafts,
    fixNowMinors(rec).map((f) => ({ id: f.id, text: f.issue })),
  );
  await noteRestated(env, restated.dropped);
  const newMinors = [...rec.newMinors, ...minorIssues(restated.kept)];
  const minorsLeft = minors.filter((m) => m.triage === "leave").length + newMinors.length;
  log.done(reReviewText({ items, verdicts: out.verdict.verdicts, stillOpen, added: findings, minorsLeft }));
  const next = await nextBranchFixRound({
    round,
    max: limitsOf(env).maxBranchFixRounds,
    followUp,
    items,
    addressed,
    open: absorbed.open,
    added: findings,
    fixBase: rec.fixBase,
    changedFiles: (base) => env.steps.changedFiles(base),
  });
  for (const note of next.notes) await env.sink.ledger(ledgerText.note(note), NO_MIRROR);
  const again = next.targets.length > 0;
  return {
    reviewOpen: [...absorbed.open, ...findings],
    nextFindingId,
    minors,
    newMinors,
    fixTargets: again ? next.targets : undefined,
    step: again ? "branch-fix" : "adjudicate",
  };
}

async function adjudicateStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (rec.reviewOpen.length === 0) return { step: "final-gates" };
  return { rulings: await env.steps.adjudicate(rec.reviewOpen), step: "final-gates" };
}

async function finalGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.fixRan) {
    featureStep("final-gates", false, true).done(
      `${gatesText(rec.repoGates?.failing ?? [])} (no fix ran; repo-gates reused)`,
    );
    return { ...(rec.repoGates ? { finalGates: rec.repoGates } : {}), step: "publish" };
  }
  const log = featureStep("final-gates", false, true);
  const run = await env.steps.repoGates();
  log.done(gatesText(run.summary.failing));
  if (run.summary.failing.length === 0)
    return { finalGates: run.summary, gateRepairFindings: undefined, step: "publish" };
  const names = run.summary.failing.join(", ");
  if (run.findings.length > 0 && gateRepairAllowed(env, rec)) {
    await env.sink.ledger(ledgerText.note(`final gates red: ${names} (repairing)`), NO_MIRROR);
    return { gateRepairFindings: run.findings, step: "gate-repair" };
  }
  await env.sink.ledger(
    ledgerText.note(`final gates red: ${names} (output in result.json featureWorkflow.finalGateFindings)`),
    NO_MIRROR,
  );
  return { finalGates: run.summary, finalGateFindings: run.findings, gateRepairFindings: undefined, step: "publish" };
}

/**
 * nax#2548: the branch fix turned green repo gates red, so a repair may still take them back. Repo
 * gates already red before the fix were the branch fix's own targets, and get no second chance here.
 */
function gateRepairAllowed(env: FeatureEnv, rec: WorkflowFeatureRecord): boolean {
  const wasGreen = rec.repoGates !== undefined && rec.repoGates.failing.length === 0;
  return wasGreen && (rec.gateRepairRounds ?? 0) < limitsOf(env).finalGateRepairRounds && !costExceeded(env);
}

async function gateRepairStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const round = (rec.gateRepairRounds ?? 0) + 1;
  const max = limitsOf(env).finalGateRepairRounds;
  if (round > max) {
    // A resume can find the cap lowered under a pending repair; the gates run again unrepaired.
    await env.sink.ledger(
      ledgerText.note(`gate repair skipped: round ${round} is past workflow.finalGateRepairRounds (${max})`),
      NO_MIRROR,
    );
    return { step: "final-gates" };
  }
  // `G` ids: a gate excerpt is no branch finding, so it never spends the B counter the summary counts.
  const findings = (rec.gateRepairFindings ?? []).map((d, i) => ({ ...d, id: `G${i + 1}` }));
  if (findings.length === 0) return { gateRepairRounds: round, step: "final-gates" };
  const list = findings.map((f) => f.id);
  await env.sink.ledger(
    ledgerText.note(`gate repair r${round}: ${findings.length} item(s): ${list.join(", ")}`),
    NO_MIRROR,
  );
  const log = featureStep(roundLabel("gate-repair", round), true, false, env.steps.modelFor?.("branch-fix"));
  const out = await env.steps.branchFix(findings);
  log.done(`${list.join(" ")}${out.failure ? ` (session failed: ${out.failure})` : ""}`);
  if (out.failure) await env.sink.ledger(ledgerText.note(`gate repair session failed: ${out.failure}`), NO_MIRROR);
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the gate repair's edits"));
  if (out.dirty) await env.sink.ledger(ledgerText.note("gate repair left uncommitted edits: the auto-commit failed"));
  return { gateRepairRounds: round, step: "final-gates" };
}

/**
 * US-005: the ids of the feature's trusted ledger decisions a human still has to confirm. Best
 * effort by design — an unreadable ledger is a warning, never a failed publish — and an empty
 * list means `publishStep` records no field, exactly like an absent step.
 */
async function collectFlaggedDecisions(env: FeatureEnv): Promise<readonly string[]> {
  if (!env.steps.flaggedDecisions) return [];
  try {
    return await env.steps.flaggedDecisions();
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Flagged advisor decisions unavailable", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return [];
  }
}

/**
 * nax#2550: HEAD read fail-soft, after a step already did its work. A failed read must not lose that
 * work, so the record just keeps no `head` (done record: it then matches no later HEAD, and the next
 * run does not skip as already finished) or no `lastHead` (a resume falls back to `startHead`).
 */
async function readHeadSoft(env: FeatureEnv): Promise<string | undefined> {
  try {
    return await env.steps.head();
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Could not read HEAD after a committing step; the record keeps the last one", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return undefined;
  }
}

async function publishStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const log = featureStep("publish", false, true);
  const out = await env.steps.publish(rec);
  const head = await readHeadSoft(env);
  const why = out.reasons.length > 0 ? `: ${out.reasons.join("; ")}` : "";
  log.done(`${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`);
  await env.sink.ledger(ledgerText.note(`feature ${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`), NO_MIRROR);
  // US-005: collected after publish, whatever it did — a local-only or draft feature still needs
  // its flagged rulings named at run end.
  const flagged = await collectFlaggedDecisions(env);
  return {
    outcome: out.outcome,
    ci: out.ci,
    reasons: out.reasons,
    ...(out.url ? { url: out.url } : {}),
    // US-001: the approval, its decision id and the CI detail survive so the verdict can read them.
    ...(out.approval ? { approval: out.approval } : {}),
    ...(out.ciDetail !== undefined ? { ciDetail: out.ciDetail } : {}),
    storyStates: env.facts.stories.map((s) => ({
      id: s.id,
      state: s.state,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    })),
    ...(head ? { head } : {}),
    passed: featurePassed({ ...(rec.finalGates ? { finalGates: rec.finalGates } : {}), stories: env.facts.stories }),
    ...(flagged.length > 0 ? { flaggedDecisions: flagged } : {}),
    endedAt: new Date().toISOString(),
    step: "done",
  };
}

const costExceeded = (env: FeatureEnv): boolean => env.costExceeded?.() === true;

/** nax#2550: the steps that run an agent session, and so spend. Gates and publish run past the limit. */
const AGENT_STEPS: ReadonlySet<FeatureStep> = new Set([
  "branch-review",
  "branch-fix",
  "branch-rereview",
  "adjudicate",
  "gate-repair",
]);

/**
 * Whether the step would open an agent session — the same emptiness checks each step makes first.
 * A step that would return without one is no spend to stop, so it never marks the record cost-limited.
 */
function hasAgentWork(step: FeatureStep, rec: WorkflowFeatureRecord): boolean {
  if (step === "branch-review") return rec.seed !== null && rec.seed !== "";
  if (step === "branch-fix") {
    const toFix = isFollowUpRound(rec)
      ? roundTargets(rec)
      : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
    return toFix.length > 0;
  }
  if (step === "branch-rereview") {
    const items = isFollowUpRound(rec) ? roundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)];
    return items.length > 0 && Boolean(rec.fixBase);
  }
  if (step === "adjudicate") return rec.reviewOpen.length > 0;
  return (rec.gateRepairFindings?.length ?? 0) > 0;
}

/**
 * Past the cost limit an agent step is skipped for the final gates — which reuse the repo gates
 * when no fix ran, and never route to a repair past the limit — so the feature still publishes,
 * as a draft, with `costLimited` as its reason.
 */
async function costStop(env: FeatureEnv, rec: WorkflowFeatureRecord, step: FeatureStep): Promise<Patch | undefined> {
  if (!AGENT_STEPS.has(step) || !hasAgentWork(step, rec) || !costExceeded(env)) return undefined;
  featureStep(step, false).done("skipped (cost limit reached)");
  await env.sink.ledger(ledgerText.note(`cost limit reached: ${step} skipped`), NO_MIRROR);
  return { costLimited: true, step: "final-gates" };
}

/** nax#2550: the steps that can commit, and so move HEAD themselves (publish: the advisor ledger commit). */
const COMMIT_STEPS: ReadonlySet<FeatureStep> = new Set(["branch-fix", "gate-repair", "publish"]);

const STEPS: Readonly<Record<Exclude<FeatureStep, "done">, StepFn>> = {
  "repo-gates": repoGatesStep,
  "branch-review": branchReviewStep,
  "branch-fix": branchFixStep,
  "branch-rereview": branchReReviewStep,
  adjudicate: adjudicateStep,
  "final-gates": finalGatesStep,
  "gate-repair": gateRepairStep,
  publish: publishStep,
};

export async function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord> {
  let rec = env.record;
  for (;;) {
    const step = rec.step;
    if (step === "done") break;
    if (env.aborted()) {
      throw new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
        stage: "workflow",
        storyId: "_run",
        step,
      });
    }
    env.sink.step(step, rec);
    const started = env.now();
    const stopped = await costStop(env, rec, step);
    const stepPatch = stopped ?? (await STEPS[step](env, rec));
    // nax#2550: a step that can commit moves HEAD on purpose; record where, so a resume is not a restart.
    // A failed read keeps the previous `lastHead`: dropping it would make a resume restart over our own commits.
    const head = !stopped && COMMIT_STEPS.has(step) ? await readHeadSoft(env) : undefined;
    const patch = head ? { ...stepPatch, lastHead: head } : stepPatch;
    rec = { ...rec, ...patch, timings: { ...rec.timings, [step]: (rec.timings[step] ?? 0) + (env.now() - started) } };
    await env.sink.update(rec);
  }
  env.sink.step("done", rec);
  return rec;
}
