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
import type { FeatureEnv, FeatureSteps } from "./feature-machine";
import { costExceeded, featureStep, limitsOf, NO_MIRROR, roundLabel } from "./feature-step-helpers";
import type { PublishOutcome } from "./finalize";
import { ledgerText } from "./ledger";
import type { WorkflowFeatureRecord, WorkflowFindingDraft } from "./types";

/**
 * US-004: a check's issue names the step that failed and the steps the job skipped after it, so the
 * repair reproduces every step that never got to run. A check with no step facts (GitLab, a non-Actions
 * check run, an unreadable jobs reply) keeps the plain failure text.
 */
function ciCheckIssue(check: FailedCheck): string {
  if (!check.failedStep) return `CI check ${check.name} failed:\n${check.excerpt}`;
  const skipped = check.skippedSteps ?? [];
  const skippedLine = skipped.length > 0 ? `\nSteps CI skipped after it, which never ran: ${skipped.join(", ")}` : "";
  return `CI check ${check.name} failed at step "${check.failedStep}".${skippedLine}\n${check.excerpt}`;
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
  return { patch: { ciRepairRounds: round, ciRepairFindings: undefined } };
}
