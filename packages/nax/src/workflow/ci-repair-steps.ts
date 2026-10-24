/**
 * US-004: the CI repair of a draft PR whose CI failed (the `ci-repair` node of the feature graph).
 *
 * The failed checks become the findings a repair session fixes, exactly as red final gates become
 * the gate repair's findings. These live outside `feature-steps.ts` because that file is at its
 * 600-line limit; they must not import it (it imports them back — `bun run check:import-cycles`).
 *
 * US-005 extends this module with the repair targets and concerns; US-006 adds the checks still
 * failing after the last round.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { FailedCheck } from "@/forge";
import type { StepResult } from "@/step-graph";
import { markdownFence } from "@/utils/markdown-fence";
import type { FeatureEnv, FeatureSteps } from "./feature-machine";
import { costExceeded, featureStep, limitsOf, NO_MIRROR, roundLabel } from "./feature-step-helpers";
import type { PublishOutcome } from "./finalize";
import { ledgerText } from "./ledger";
import type { CiCheckRef, CiRemainingCheck, WorkflowFeatureRecord, WorkflowFindingDraft } from "./types";

/**
 * US-004: a check's issue names the step that failed and the steps the job skipped after it, so the
 * repair reproduces every step that never got to run. A check with no step facts (GitLab, a non-Actions
 * check run, an unreadable jobs reply) keeps the plain failure text.
 */
function ciCheckIssue(check: FailedCheck): string {
  const excerpt = markdownFence(check.excerpt);
  if (!check.failedStep) return `CI check ${check.name} failed:\n${excerpt}`;
  const skipped = check.skippedSteps ?? [];
  const skippedLine = skipped.length > 0 ? `\nSteps CI skipped after it, which never ran: ${skipped.join(", ")}` : "";
  return `CI check ${check.name} failed at step "${check.failedStep}".${skippedLine}\n${excerpt}`;
}

/**
 * US-006: the failed checks of a PR's CI, as the findings the CI repair round repairs. A CI check
 * is not a repo gate, but it is the same kind of work: make this check pass.
 */
function ciRepairFindingsOf(checks: readonly FailedCheck[]): WorkflowFindingDraft[] {
  return checks.map((check) => ({
    kind: "gate",
    severity: "important",
    issue: ciCheckIssue(check),
    ...(check.url ? { suggestion: `See ${check.url}` } : {}),
  }));
}

/**
 * US-005: the checks a repair round targets, as the record keeps them. One small ref per failed
 * check, so `result.json` says what the repair was for without repeating the log excerpt.
 */
function ciRepairTargetsOf(checks: readonly FailedCheck[]): CiCheckRef[] {
  return checks.map((check) => ({
    name: check.name,
    ...(check.failedStep ? { failedStep: check.failedStep } : {}),
  }));
}

/** US-005: what one CI read decides — the findings to repair and the checks they came from. */
export interface CiRepairPlan {
  readonly findings: readonly WorkflowFindingDraft[];
  readonly targets: readonly CiCheckRef[];
}

/**
 * US-006: read the failed checks of the published PR and turn them into repair findings. An empty
 * list and a failed read are both "no repair": the ledger says which, and the publish outcome
 * stands. US-005: the same single read yields the checks the repair targets, so the publish step
 * never has to read the CI twice.
 */
async function readCiFailuresForRepair(
  env: FeatureEnv,
  reader: NonNullable<FeatureSteps["readCiFailures"]>,
  url: string,
  head: string,
): Promise<CiRepairPlan | undefined> {
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
  return { findings: ciRepairFindingsOf(checks), targets: ciRepairTargetsOf(checks) };
}

/**
 * US-006: whether the published PR's failed CI is worth a repair round, and what to repair.
 *
 * Only a draft PR whose CI failed can be repaired, and only while the run has an allowance left
 * and money to spend. Every other answer is silence: the publish outcome stands as it was.
 * US-005: one read decides both the findings and the targets.
 */
export async function ciRepairPlan(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<CiRepairPlan | undefined> {
  const reader = env.steps.readCiFailures;
  if (!reader) return undefined;
  if (out.outcome !== "draft" || out.ci !== "failed") return undefined;
  if (!out.url || !head) return undefined;
  if ((rec.ciRepairRounds ?? 0) >= (limitsOf(env).ciRepairRounds ?? 0)) return undefined;
  if (costExceeded(env)) return undefined;
  return await readCiFailuresForRepair(env, reader, out.url, head);
}

/**
 * The plan's findings alone. Its callers and tests predate the targets, so the compatibility
 * wrapper keeps the findings-only answer — the publish step uses `ciRepairPlan` directly, which is
 * what keeps the targets and the findings on one read.
 */
export async function ciRepairDecision(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<readonly WorkflowFindingDraft[] | undefined> {
  return (await ciRepairPlan(env, rec, out, head))?.findings;
}

/** US-006: whether a repair round ran and the allowance is used up. */
function repairRoundsSpent(env: FeatureEnv, rounds: number): boolean {
  return rounds >= 1 && rounds >= (limitsOf(env).ciRepairRounds ?? 0);
}

/** US-006: a check is only "still failing" when a target names it *and* the step it failed at. */
function sameTarget(target: CiCheckRef, check: FailedCheck): boolean {
  return target.name === check.name && target.failedStep === check.failedStep;
}

/** US-006: one check as the record keeps it — the name, the step when known, and the verdict. */
function ciRemainingCheckOf(targets: readonly CiCheckRef[], check: FailedCheck): CiRemainingCheck {
  return {
    name: check.name,
    ...(check.failedStep ? { failedStep: check.failedStep } : {}),
    newFailure: !targets.some((target) => sameTarget(target, check)),
  };
}

/** US-006: `<name>[ at step "<step>"] (new failure|still failing)`, checks joined by `; `. */
function stillFailingNote(rounds: number, remaining: readonly CiRemainingCheck[]): string {
  const checks = remaining.map((check) => {
    const step = check.failedStep ? ` at step "${check.failedStep}"` : "";
    return `${check.name}${step} (${check.newFailure ? "new failure" : "still failing"})`;
  });
  return `CI still failing after ${rounds} repair round(s): ${checks.join("; ")}`;
}

/**
 * US-006: the checks still failing after the last repair round, recorded rather than repaired.
 *
 * The repair's allowance is spent — its tokens are booked with the branch fix — so there is nothing
 * left to schedule and no agent to run: the read only says what is still red, for the ledger,
 * `result.json` and the end-of-run summary. It reads through `env.steps.readCiFailures` directly,
 * never `readCiFailuresForRepair`, so it can never write the `(repairing)` note of a repair that is
 * not happening. This condition and `ciRepairPlan`'s (a round left) never both hold, so a publish
 * reads the failed checks at most once.
 *
 * A thrown read is one ledger note and no record; an empty list is neither a record nor a note.
 */
export async function ciRemainingAfterRepair(
  env: FeatureEnv,
  rec: WorkflowFeatureRecord,
  out: PublishOutcome,
  head: string | undefined,
): Promise<readonly CiRemainingCheck[] | undefined> {
  const reader = env.steps.readCiFailures;
  if (!reader) return undefined;
  if (out.outcome !== "draft" || out.ci !== "failed") return undefined;
  if (!out.url || !head) return undefined;
  const rounds = rec.ciRepairRounds ?? 0;
  if (!repairRoundsSpent(env, rounds)) return undefined;
  let checks: readonly FailedCheck[];
  try {
    checks = await reader({ url: out.url, head });
  } catch (err) {
    await env.sink.ledger(ledgerText.note(`CI logs unavailable: ${errorMessage(err)}`), NO_MIRROR);
    return undefined;
  }
  if (checks.length === 0) return undefined;
  const targets = rec.ciRepairTargets ?? [];
  const remaining = checks.map((check) => ciRemainingCheckOf(targets, check));
  await env.sink.ledger(ledgerText.note(stillFailingNote(rounds, remaining)), NO_MIRROR);
  return remaining;
}

/**
 * US-007: the CI repair round. The failed checks of the published PR become the findings a repair
 * session repairs (US-002's `wf-repair`), exactly as the red final gates become the gate repair's
 * findings. The run then goes back to the final gates, which read the repo's own gates again.
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
  const out = await env.steps.branchFix(findings, {
    repair: true,
    ...(rec.url ? { prUrl: rec.url } : {}),
    // US-004: the round reaches the session, so it builds the CI repair's brief — and labels the
    // section it appends to the report with the round it is repairing.
    ciRound: round,
  });
  log.done(`${list.join(" ")}${out.failure ? ` (session failed: ${out.failure})` : ""}`);
  if (out.failure) await env.sink.ledger(ledgerText.note(`CI repair session failed: ${out.failure}`), NO_MIRROR);
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the CI repair's edits"));
  if (out.dirty) await env.sink.ledger(ledgerText.note("CI repair left uncommitted edits: the auto-commit failed"));
  // US-005: a repair whose reply admits it could not check something must not read as done. The
  // round labels the entry, and every earlier round's entry stays: the history is the point.
  const concerns = out.reply?.concerns?.trim() ?? "";
  const raised = await noteConcerns(env, round, concerns, rec.ciRepairConcerns ?? []);
  return { patch: { ciRepairRounds: round, ciRepairFindings: undefined, ...raised } };
}

/**
 * US-005: the ledger note and the record patch for one round's concerns. An empty reply (no
 * `concerns` field, an empty one, or no reply at all) writes no note and patches no key — the
 * field's presence alone would otherwise say a repair admitted something.
 */
async function noteConcerns(
  env: FeatureEnv,
  round: number,
  concerns: string,
  history: readonly string[],
): Promise<ConcernsPatch> {
  if (concerns.length === 0) return {};
  await env.sink.ledger(ledgerText.note(`CI repair r${round} concerns: ${concerns}`), NO_MIRROR);
  return { ciRepairConcerns: [...history, `r${round}: ${concerns}`] };
}

/** US-005: the concerns history a round adds to the record — nothing at all when it raised none. */
type ConcernsPatch = Partial<Pick<WorkflowFeatureRecord, "ciRepairConcerns">>;
