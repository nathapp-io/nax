/**
 * The feature workflow (spec §7) as a state machine. Pure orchestration over injected
 * steps, persisted after every step (P4-R1), so a crash resumes at `record.step`.
 * One branch review, one fix pass (plus one targeted second pass for defects the fix introduced, #2496),
 * one scoped re-review per pass, one adjudication.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { FEATURE_SCOPE } from "./advisor-live";
import { featurePassed } from "./approval";
import type { BranchFixOutcome } from "./branch-fix";
import type { BranchReviewFacts } from "./branch-review";
import type { PublishOutcome } from "./finalize";
import { type LedgerWriteOptions, ledgerText } from "./ledger";
import type { LedgerItem } from "./ledger-items";
import { absorbReReviewVerdict } from "./re-review-absorb";
import type { RepoGateRun } from "./repo-gates";
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
  readonly now: () => number;
}

type Patch = Partial<WorkflowFeatureRecord>;
type StepFn = (env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<Patch>;

/** The step line in the log already says it; ledger.md still records it. */
const NO_MIRROR: LedgerWriteOptions = { mirror: false };

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";
const minorIssues = (drafts: readonly WorkflowFindingDraft[]): string[] =>
  drafts.filter((f) => !isBlocking(f)).map((f) => f.issue);

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

const MAX_BRANCH_FIX_ROUNDS = 2;
const fixRoundsOf = (rec: WorkflowFeatureRecord): number => rec.fixRounds ?? (rec.fixRan ? 1 : 0);
const isSecondRound = (rec: WorkflowFeatureRecord): boolean =>
  fixRoundsOf(rec) >= 1 && (rec.fixTargets?.length ?? 0) > 0;
const repoPath = (file: string): string => file.replace(/^\.\//, "");

function secondRoundTargets(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  const ids = new Set(rec.fixTargets ?? []);
  return rec.reviewOpen.filter((f) => ids.has(f.id));
}

/** #2496: one more fix only when the first fix is clean and its own diff introduced the new defects. */
async function secondFixEligible(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  stillOpen: ReadonlySet<string>,
  added: readonly WorkflowFinding[],
): Promise<boolean> {
  if (fixRoundsOf(rec) >= MAX_BRANCH_FIX_ROUNDS || stillOpen.size > 0 || added.length === 0 || !rec.fixBase)
    return false;
  if (added.some((f) => !f.file)) return false;
  try {
    const changed = new Set((await env.steps.changedFiles(rec.fixBase)).map(repoPath));
    return added.every((f) => f.file !== undefined && changed.has(repoPath(f.file)));
  } catch (err) {
    await env.sink.ledger(
      ledgerText.note(`second branch fix skipped: could not list the fix diff (${errorMessage(err)})`),
      NO_MIRROR,
    );
    return false;
  }
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
  const triage = new Map(out.verdict.minorTriage.map((t) => [t.id, t.decision]));
  const { findings, nextFindingId } = assign(rec, out.verdict.findings.filter(isBlocking));
  const minors = out.verdict.findings.filter((f) => !isBlocking(f));
  // #2496: written here, after assign(), so the file and result.json name findings the same way.
  await env.sink.artifact("branch-review.json", { ...out.verdict, findings: [...findings, ...minors] });
  log.done(`spec ${out.verdict.spec}, quality ${out.verdict.quality} - ${describeFindings([...findings, ...minors])}`);
  return {
    reviewRan: true,
    cannotVerify: out.verdict.cannotVerify,
    reviewOpen: findings,
    nextFindingId,
    minors: rec.minors.map((m) => ({ ...m, triage: triage.get(m.id) ?? "leave" })),
    newMinors: [...rec.newMinors, ...minorIssues(out.verdict.findings)],
    step: "branch-fix",
  };
}

async function branchFixStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const round = fixRoundsOf(rec) + 1;
  const toFix = isSecondRound(rec)
    ? secondRoundTargets(rec)
    : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { step: "branch-rereview" };
  const fixBase = await env.steps.head();
  await env.sink.ledger(
    ledgerText.note(
      `${round > 1 ? `branch fix r${round}` : "branch fix"}: ${toFix.length} item(s): ${toFix.map((f) => f.id).join(", ")}`,
    ),
    NO_MIRROR,
  );
  const log = featureStep(
    round > 1 ? `branch-fix r${round}` : "branch-fix",
    true,
    false,
    env.steps.modelFor?.("branch-fix"),
  );
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
  const second = isSecondRound(rec);
  const items = second ? secondRoundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)];
  if (items.length === 0 || !rec.fixBase) return { step: "adjudicate" };
  const log = featureStep(
    second ? "branch-rereview r2" : "branch-rereview",
    true,
    false,
    env.steps.modelFor?.("branch-rereview"),
  );
  const out = await env.steps.branchReReview(items, rec.fixBase);
  if (!out.ran) {
    log.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`branch re-review: ${out.why}`), NO_MIRROR);
    return { step: "adjudicate" };
  }
  // Fail closed: an item the verdicts do not mark addressed stays open, omitted or not.
  const addressed = new Set(out.verdict.verdicts.filter((v) => v.addressed).map((v) => v.id));
  const stillOpen = new Set(items.map((f) => f.id).filter((id) => !addressed.has(id)));
  // US-004: only the review findings are absorbed — the fix-now minors keep their own triage handling.
  const absorbed = absorbReReviewVerdict(rec.reviewOpen, out.verdict);
  const { findings, nextFindingId } = assign(rec, absorbed.newDrafts.filter(isBlocking));
  await env.sink.artifact(second ? "branch-rereview-r2.json" : "branch-rereview.json", {
    ...out.verdict,
    newFindings: [...findings, ...absorbed.newDrafts.filter((f) => !isBlocking(f))],
  });
  const minors = rec.minors.map((m) =>
    m.triage === "fix-now" && stillOpen.has(m.id) ? { ...m, triage: "leave" as const } : m,
  );
  const newMinors = [...rec.newMinors, ...minorIssues(absorbed.newDrafts)];
  const minorsLeft = minors.filter((m) => m.triage === "leave").length + newMinors.length;
  log.done(reReviewText({ items, verdicts: out.verdict.verdicts, stillOpen, added: findings, minorsLeft }));
  const again = !second && (await secondFixEligible(env, rec, stillOpen, findings));
  if (again) {
    await env.sink.ledger(
      ledgerText.note(`second branch fix: ${findings.map((f) => f.id).join(", ")} introduced by the fix`),
      NO_MIRROR,
    );
  }
  return {
    reviewOpen: [...absorbed.open, ...findings],
    nextFindingId,
    minors,
    newMinors,
    ...(again ? { fixTargets: findings.map((f) => f.id) } : {}),
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
  if (run.summary.failing.length === 0) return { finalGates: run.summary, step: "publish" };
  const names = run.summary.failing.join(", ");
  await env.sink.ledger(
    ledgerText.note(`final gates red: ${names} (output in result.json featureWorkflow.finalGateFindings)`),
    NO_MIRROR,
  );
  return { finalGates: run.summary, finalGateFindings: run.findings, step: "publish" };
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

async function publishStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const log = featureStep("publish", false, true);
  const out = await env.steps.publish(rec);
  const head = await env.steps.head();
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
    head,
    passed: featurePassed({ ...(rec.finalGates ? { finalGates: rec.finalGates } : {}), stories: env.facts.stories }),
    ...(flagged.length > 0 ? { flaggedDecisions: flagged } : {}),
    endedAt: new Date().toISOString(),
    step: "done",
  };
}

const STEPS: Readonly<Record<Exclude<FeatureStep, "done">, StepFn>> = {
  "repo-gates": repoGatesStep,
  "branch-review": branchReviewStep,
  "branch-fix": branchFixStep,
  "branch-rereview": branchReReviewStep,
  adjudicate: adjudicateStep,
  "final-gates": finalGatesStep,
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
    const patch = await STEPS[step](env, rec);
    rec = { ...rec, ...patch, timings: { ...rec.timings, [step]: (rec.timings[step] ?? 0) + (env.now() - started) } };
    await env.sink.update(rec);
  }
  env.sink.step("done", rec);
  return rec;
}
