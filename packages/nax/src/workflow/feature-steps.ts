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
import type { FailedCheck } from "@/forge";
import { getSafeLogger } from "@/logger";
import type { StepResult } from "@/step-graph";
import { FEATURE_SCOPE } from "./advisor-live";
import { describeUnread, featurePassed } from "./approval";
import { dropKnownRestatements, type FeatureLimits, nextBranchFixRound } from "./branch-fix-rounds";
import type { BranchReviewFacts } from "./branch-review";
import type { FeatureEnv, FeatureSteps } from "./feature-machine";
import type { PublishOutcome } from "./finalize";
import { ledgerCannotVerify } from "./gate-timing";
import { type LedgerWriteOptions, ledgerText } from "./ledger";
import { postItemThreadsAfterPublish } from "./publish-item-threads";
import { absorbReReviewVerdict } from "./re-review-absorb";
import { type RestatedMinor, splitRestatedMinors } from "./restated-minors";
import { describeFindings, type StepModel, startStep } from "./run-log";
import type {
  BranchReviewVerdict,
  MinorItem,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowFindingDraft,
} from "./types";

const DEFAULT_LIMITS: FeatureLimits = {
  maxBranchFixRounds: WORKFLOW_DEFAULTS.maxBranchFixRounds,
  finalGateRepairRounds: WORKFLOW_DEFAULTS.finalGateRepairRounds,
  ciRepairRounds: WORKFLOW_DEFAULTS.ciRepairRounds,
};
const limitsOf = (env: FeatureEnv): FeatureLimits => env.limits ?? DEFAULT_LIMITS;

const costExceeded = (env: FeatureEnv): boolean => env.costExceeded?.() === true;

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

export async function repoGatesStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
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
  return { patch: { repoGates: run.summary, gateFindings: findings, nextFindingId } };
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

export async function branchReviewStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  if (!rec.seed) {
    featureStep("branch-review", false).done("skipped (no seed)");
    await env.sink.ledger(ledgerText.reviewSkipped("branch review: no seed"), NO_MIRROR);
    return { patch: { reviewRan: false } };
  }
  const log = featureStep("branch-review", true, false, env.steps.modelFor?.("branch-review"));
  const out = await env.steps.branchReview(rec.seed, reviewFacts(env, rec));
  if (!out.ran) {
    log.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`branch review: ${out.why}`), NO_MIRROR);
    return { patch: { reviewRan: false } };
  }
  const cannotVerify = await ledgerCannotVerify(env.sink, out.verdict.cannotVerify);
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
  await env.sink.artifact("branch-review.json", { ...out.verdict, cannotVerify, findings: [...findings, ...minors] });
  log.done(`spec ${out.verdict.spec}, quality ${out.verdict.quality} - ${describeFindings([...findings, ...minors])}`);
  return {
    patch: {
      reviewRan: true,
      cannotVerify,
      ...(unread.length > 0 ? { reviewUnread: unread } : {}),
      reviewOpen: findings,
      nextFindingId,
      minors: rec.minors.map((m) => ({ ...m, triage: triage.get(m.id) ?? "leave" })),
      newMinors: [...rec.newMinors, ...minorIssues(restated.kept)],
    },
  };
}

export async function branchFixStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  const round = fixRoundsOf(rec) + 1;
  const toFix = isFollowUpRound(rec)
    ? roundTargets(rec)
    : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { patch: {}, exit: "nothing-to-fix" };
  const max = limitsOf(env).maxBranchFixRounds;
  if (round > max) {
    // A resume can find a cap lowered under a pending round; the cap wins.
    const why =
      max === 0 ? "workflow.maxBranchFixRounds is 0" : `round ${round} is past workflow.maxBranchFixRounds (${max})`;
    await env.sink.ledger(ledgerText.note(`branch fix skipped: ${why}`), NO_MIRROR);
    return { patch: {}, exit: "capped" };
  }
  // A follow-up round keeps round 1's base, so its re-review sees the whole fix, not just the last edit.
  const fixBase = round > 1 && rec.fixBase ? rec.fixBase : await readHeadSoft(env);
  if (!fixBase) {
    // nax#2550: no base means no re-review of the fix, so no fix runs; the findings go to adjudication
    // as with a round cap, and the run goes on instead of losing the feature workflow to a git blip.
    await env.sink.ledger(ledgerText.note("branch fix skipped: HEAD could not be read"), NO_MIRROR);
    return { patch: {}, exit: "no-base" };
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
  return { patch: { fixBase, fixRan: true, fixRounds: round }, exit: "fixed" };
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

export async function branchReReviewStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  const round = fixRoundsOf(rec);
  const followUp = isFollowUpRound(rec);
  const items = followUp ? roundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)];
  if (items.length === 0 || !rec.fixBase) return { patch: {}, exit: "nothing-to-check" };
  const log = featureStep(roundLabel("branch-rereview", round), true, false, env.steps.modelFor?.("branch-rereview"));
  const out = await env.steps.branchReReview(items, rec.fixBase);
  if (!out.ran) {
    log.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`branch re-review: ${out.why}`), NO_MIRROR);
    // nax#2550: the fix commits stay unreviewed, and `publish` must say so (a draft, not a ready PR).
    return { patch: { reReviewSkipped: true }, exit: "skipped" };
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
    patch: {
      reviewOpen: [...absorbed.open, ...findings],
      nextFindingId,
      minors,
      newMinors,
      fixTargets: again ? next.targets : undefined,
    },
    exit: again ? "again" : "settled",
  };
}

export async function adjudicateStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  if (rec.reviewOpen.length === 0) return { patch: {} };
  return { patch: { rulings: await env.steps.adjudicate(rec.reviewOpen) } };
}

export async function finalGatesStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  // US-007: a CI repair changed the branch since the repo gates were read, so they are read again.
  if (!rec.fixRan && !rec.ciRepairRounds) {
    featureStep("final-gates", false, true).done(
      `${gatesText(rec.repoGates?.failing ?? [])} (no fix ran; repo-gates reused)`,
    );
    return { patch: rec.repoGates ? { finalGates: rec.repoGates } : {}, exit: "reused" };
  }
  const log = featureStep("final-gates", false, true);
  const run = await env.steps.repoGates();
  log.done(gatesText(run.summary.failing));
  if (run.summary.failing.length === 0)
    return { patch: { finalGates: run.summary, gateRepairFindings: undefined }, exit: "green" };
  const names = run.summary.failing.join(", ");
  if (run.findings.length > 0 && gateRepairAllowed(env, rec)) {
    await env.sink.ledger(ledgerText.note(`final gates red: ${names} (repairing)`), NO_MIRROR);
    return { patch: { gateRepairFindings: run.findings }, exit: "repair" };
  }
  await env.sink.ledger(
    ledgerText.note(`final gates red: ${names} (output in result.json featureWorkflow.finalGateFindings)`),
    NO_MIRROR,
  );
  return {
    patch: {
      finalGates: run.summary,
      finalGateFindings: run.findings,
      gateRepairFindings: undefined,
    },
    exit: "red",
  };
}

/**
 * nax#2548: the branch fix turned green repo gates red, so a repair may still take them back. Repo
 * gates already red before the fix were the branch fix's own targets, and get no second chance here.
 */
function gateRepairAllowed(env: FeatureEnv, rec: WorkflowFeatureRecord): boolean {
  const wasGreen = rec.repoGates !== undefined && rec.repoGates.failing.length === 0;
  return wasGreen && (rec.gateRepairRounds ?? 0) < limitsOf(env).finalGateRepairRounds && !costExceeded(env);
}

export async function gateRepairStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  const round = (rec.gateRepairRounds ?? 0) + 1;
  const max = limitsOf(env).finalGateRepairRounds;
  if (round > max) {
    // A resume can find the cap lowered under a pending repair; the gates run again unrepaired.
    await env.sink.ledger(
      ledgerText.note(`gate repair skipped: round ${round} is past workflow.finalGateRepairRounds (${max})`),
      NO_MIRROR,
    );
    return { patch: {} };
  }
  // `G` ids: a gate excerpt is no branch finding, so it never spends the B counter the summary counts.
  const findings = (rec.gateRepairFindings ?? []).map((d, i) => ({ ...d, id: `G${i + 1}` }));
  if (findings.length === 0) return { patch: { gateRepairRounds: round } };
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
  return { patch: { gateRepairRounds: round } };
}

/**
 * US-007: the CI repair round. The failed checks of the published PR become the findings a
 * branch-fix session repairs, exactly as the red final gates become the gate repair's findings.
 * The run then goes back to the final gates, which read the repo's own gates again.
 */
export async function ciRepairStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  const round = (rec.ciRepairRounds ?? 0) + 1;
  const max = limitsOf(env).ciRepairRounds ?? 0;
  if (round > max) {
    // A resume can find the cap lowered under a pending repair; the CI stays as it is.
    await env.sink.ledger(
      ledgerText.note(`CI repair skipped: round ${round} is past workflow.ciRepairRounds (${max})`),
      NO_MIRROR,
    );
    return { patch: {} };
  }
  // `C` ids: a CI check is no branch finding, so it never spends the B counter the summary counts.
  const findings = (rec.ciRepairFindings ?? []).map((d, i) => ({ ...d, id: `C${i + 1}` }));
  if (findings.length === 0) return { patch: { ciRepairRounds: round } };
  const list = findings.map((f) => f.id);
  await env.sink.ledger(
    ledgerText.note(`CI repair r${round}: ${findings.length} item(s): ${list.join(", ")}`),
    NO_MIRROR,
  );
  const log = featureStep(roundLabel("ci-repair", round), true, false, env.steps.modelFor?.("branch-fix"));
  const out = await (rec.url ? env.steps.branchFix(findings, { prUrl: rec.url }) : env.steps.branchFix(findings));
  log.done(`${list.join(" ")}${out.failure ? ` (session failed: ${out.failure})` : ""}`);
  if (out.failure) await env.sink.ledger(ledgerText.note(`CI repair session failed: ${out.failure}`), NO_MIRROR);
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the CI repair's edits"));
  if (out.dirty) await env.sink.ledger(ledgerText.note("CI repair left uncommitted edits: the auto-commit failed"));
  return { patch: { ciRepairRounds: round, ciRepairFindings: undefined } };
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

/**
 * US-006: the failed checks of a PR's CI, as the findings the CI repair round repairs. A CI check
 * is not a repo gate, but it is the same kind of work: make this check pass.
 */
function ciRepairFindingsOf(checks: readonly FailedCheck[]): WorkflowFindingDraft[] {
  return checks.map((check) => ({
    kind: "gate",
    severity: "important",
    issue: `CI check ${check.name} failed:\n${check.excerpt}`,
    ...(check.url ? { suggestion: `See ${check.url}` } : {}),
  }));
}

/**
 * US-006: read the failed checks of the published PR and turn them into repair findings. An empty
 * list and a failed read are both "no repair": the ledger says which, and the publish outcome
 * stands.
 */
async function readCiFailuresForRepair(
  env: FeatureEnv,
  reader: NonNullable<FeatureSteps["readCiFailures"]>,
  url: string,
  head: string,
): Promise<readonly WorkflowFindingDraft[] | undefined> {
  let checks: readonly FailedCheck[];
  try {
    checks = await reader({ url, head });
  } catch (err) {
    await env.sink.ledger(ledgerText.note(`CI logs unavailable: ${errorMessage(err)}`), NO_MIRROR);
    return undefined;
  }
  if (checks.length === 0) {
    await env.sink.ledger(ledgerText.note(`CI failed but no failed check was found for ${head}`), NO_MIRROR);
    return undefined;
  }
  if (checks.every((check) => check.logUnavailable === true)) {
    await env.sink.ledger(
      ledgerText.note(
        `CI repair skipped: no failed check's log could be read (${checks.map((check) => check.name).join(", ")})`,
      ),
      NO_MIRROR,
    );
    return undefined;
  }
  await env.sink.ledger(
    ledgerText.note(`CI failed: ${checks.map((check) => check.name).join(", ")} (repairing)`),
    NO_MIRROR,
  );
  return ciRepairFindingsOf(checks);
}

/**
 * US-006: whether the published PR's failed CI is worth a repair round, and what to repair.
 *
 * Only a draft PR whose CI failed can be repaired, and only while the run has an allowance left
 * and money to spend. Every other answer is silence: the publish outcome stands as it was.
 */
export async function ciRepairDecision(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<readonly WorkflowFindingDraft[] | undefined> {
  const reader = env.steps.readCiFailures;
  if (!reader) return undefined;
  if (out.outcome !== "draft" || out.ci !== "failed") return undefined;
  if (!out.url || !head) return undefined;
  if ((rec.ciRepairRounds ?? 0) >= (limitsOf(env).ciRepairRounds ?? 0)) return undefined;
  if (costExceeded(env)) return undefined;
  return await readCiFailuresForRepair(env, reader, out.url, head);
}

export async function publishStep(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
): Promise<StepResult<WorkflowFeatureRecord>> {
  const log = featureStep("publish", false, true);
  const out = await env.steps.publish(rec);
  const head = await readHeadSoft(env);
  // nax#2646: threads and CI reads cite the pushed head; the record keeps local HEAD, the ruling's commit included.
  const published = out.pushedHead ?? head;
  const flagged = await collectFlaggedDecisions(env);
  await postItemThreadsAfterPublish(env, { ...rec, flaggedDecisions: flagged }, out, published);
  const why = out.reasons.length > 0 ? `: ${out.reasons.join("; ")}` : "";
  log.done(`${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`);
  await env.sink.ledger(ledgerText.note(`feature ${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`), NO_MIRROR);
  // US-006: a draft PR whose CI failed may still be repairable, so the decision reads the failed
  // checks before the step ends. It never changes the publish outcome itself: the repair is a
  // separate node, and a run that may not repair keeps the draft it has.
  const ciFindings = await ciRepairDecision(env, rec, out, published);
  // US-005: collected after publish, whatever it did — a local-only or draft feature still needs
  // its flagged rulings named at run end.
  return {
    patch: {
      outcome: out.outcome,
      ci: out.ci,
      reasons: out.reasons,
      ...(out.url ? { url: out.url } : {}),
      // US-001/B1: these two are *this* publish's facts, so they are written unconditionally. An
      // absent approval means this publish asked no advisor, and a CI state with no detail is no
      // detail — the patch clears what the earlier publish recorded instead of leaving it behind
      // (the url is deliberately not cleared: the re-publish keeps the PR an earlier one opened).
      approval: out.approval,
      ciDetail: out.ciDetail,
      storyStates: env.facts.stories.map((s) => ({
        id: s.id,
        state: s.state,
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      })),
      ...(head ? { head } : {}),
      passed: featurePassed({ ...(rec.finalGates ? { finalGates: rec.finalGates } : {}), stories: env.facts.stories }),
      ...(flagged.length > 0 || rec.flaggedDecisions !== undefined ? { flaggedDecisions: flagged } : {}),
      // US-006: the repair targets, only when there is a repair to make.
      ...(ciFindings ? { ciRepairFindings: ciFindings } : {}),
      endedAt: new Date().toISOString(),
    },
    ...(ciFindings ? { exit: "ci-repair" } : {}),
  };
}

export { featureStep, fixNowMinors, isFollowUpRound, NO_MIRROR, readHeadSoft, roundTargets };
