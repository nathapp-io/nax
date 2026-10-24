/**
 * runWorkflowFeature (spec §7): after the last story, one feature workflow — repo gates,
 * one branch review, one branch fix, one re-review, adjudication, gates again, then publish.
 * Resumes an unfinished prior record; skips when already finished at this HEAD (P4-R1).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";
import { pipelineEventBus, type WorkflowPublishedEvent } from "@/pipeline/event-bus";
import { FEATURE_SCOPE } from "./advisor-live";
import { featurePassed } from "./approval";
import { specPathFor } from "./brief";
import { buildFeatureContext, type FeatureContext, type WorkflowFeatureInput } from "./feature-context";
import { buildFeatureEnv } from "./feature-env";
import { runFeatureMachine } from "./feature-machine";
import {
  collectStoryRecords,
  loadPriorFeature,
  minorsFrom,
  newestPreflight,
  newFeatureRecord,
  summariseStories,
} from "./feature-record";
import { onlyLedgerChangedSince, readHead } from "./git";
import { appendLedger, ensureLedger, ledgerText } from "./ledger";
import { collectLedgerItems } from "./ledger-items";
import { logWorkflow } from "./run-log";
import { resolveSeed } from "./seed";
import { workflowStatusBlock } from "./status-block";
import { startTokenMeter, type TokenMeter } from "./tokens";
import { clearToolErrorClaims } from "./tool-error-outcome";
import type { FeatureOutcome, StorySummary, WorkflowFeatureRecord } from "./types";

export interface WorkflowFeatureResult {
  readonly passed: boolean;
  readonly outcome: FeatureOutcome | "already-finished";
  readonly url?: string;
  readonly reasons: readonly string[];
}

export const _featureRunDeps = { buildFeatureContext, runFeatureMachine };

export async function runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null> {
  if (input.runtime.dryRun || input.abortSignal?.aborted) {
    getSafeLogger()?.info("workflow", "Feature workflow skipped", {
      storyId: "_run",
      reason: input.runtime.dryRun ? "dry-run" : "aborted",
    });
    return null;
  }
  const meter = startTokenMeter(input.runtime.dispatchEvents);
  try {
    const { fc, dispose } = await _featureRunDeps.buildFeatureContext(input);
    try {
      return await runInContext(fc, input, meter);
    } finally {
      await dispose();
    }
  } finally {
    meter.stop();
    clearToolErrorClaims(input.runtime.runId);
  }
}

function resultOf(rec: WorkflowFeatureRecord): WorkflowFeatureResult {
  return {
    passed: rec.passed ?? false,
    outcome: rec.outcome ?? "local-only",
    ...(rec.url ? { url: rec.url } : {}),
    reasons: rec.reasons,
  };
}

/**
 * US-003: the final record as a bus event. Same defaults as `resultOf` — a record with no outcome
 * published nothing beyond the branch, and a record with no verdict did not pass — plus the CI state
 * and PR url, each omitted when the record has none.
 */
function publishedEvent(rec: WorkflowFeatureRecord): WorkflowPublishedEvent {
  return {
    type: "workflow:published",
    outcome: rec.outcome ?? "local-only",
    ...(rec.ci ? { ci: rec.ci } : {}),
    ...(rec.url ? { url: rec.url } : {}),
    passed: rec.passed ?? false,
    reasons: rec.reasons,
  };
}

/**
 * nax#2550: HEAD, or undefined when git cannot report it. The caller decides what an unknown HEAD
 * means: never a match for a finished record, never proof that a resumed record is still current.
 */
async function currentHead(fc: FeatureContext): Promise<string | undefined> {
  try {
    return await readHead(fc.projectDir);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Could not read HEAD for the feature workflow", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return undefined;
  }
}

/** `onlyLedgerChangedSince`, fail-soft: a throw reads as "moved", which restarts — the safe default. */
async function ledgerOnlySince(fc: FeatureContext, base: string): Promise<boolean> {
  try {
    return await onlyLedgerChangedSince(fc.projectDir, fc.feature, base);
  } catch {
    // A git failure is an unknown answer, and an unknown HEAD never proves a record is current.
    return false;
  }
}

async function freshRecord(fc: FeatureContext, head: string | undefined): Promise<WorkflowFeatureRecord> {
  return newFeatureRecord({
    now: new Date().toISOString(),
    seed: await resolveSeed(fc.projectDir, fc.prd),
    minors: minorsFrom((await collectLedgerItems(fc.featureDir)).deferredMinors),
    ...(head ? { head } : {}),
  });
}

/**
 * A resumed record is only as good as the HEAD it was recorded on (nax#2550). When HEAD moved, or
 * cannot be read, its repo gates, open findings and `fixBase` describe other code, so the workflow
 * restarts at `repo-gates`. The start time, step timings, token totals and the finding-id counter carry
 * over, so the cost already spent stays on the record and a new `B` id never repeats an old one.
 * The reference is `lastHead ?? startHead`: the HEAD the workflow itself last recorded, so its own fix
 * and repair commits are not "movement". A record with neither (written before the fields) resumes as
 * it always did.
 */
async function resumeOrRestart(
  fc: FeatureContext,
  prior: WorkflowFeatureRecord,
  head: string | undefined,
): Promise<WorkflowFeatureRecord> {
  const recorded = prior.lastHead ?? prior.startHead;
  if (recorded === undefined || (head !== undefined && recorded === head)) {
    await appendLedger(fc.runDir, "_run", ledgerText.note(`resumed the feature workflow at ${prior.step}`));
    return prior;
  }
  // Publish commits the ledger before it pushes and waits for CI, and the record only moves on once the
  // step returns, so a crash in that window leaves HEAD one ledger commit past `lastHead`. That is not
  // movement: restarting would rerun the branch review and fixes and reset every round counter.
  if (head !== undefined && (await ledgerOnlySince(fc, recorded))) {
    await appendLedger(
      fc.runDir,
      "_run",
      ledgerText.note(`resumed the feature workflow at ${prior.step} (HEAD moved only by the advisor-ledger commit)`),
    );
    return { ...prior, lastHead: head };
  }
  await appendLedger(
    fc.runDir,
    "_run",
    ledgerText.note(
      `HEAD ${head ? "moved since" : "could not be read for"} the interrupted feature workflow at ${prior.step}: restarting at repo-gates`,
    ),
  );
  return {
    ...(await freshRecord(fc, head)),
    startedAt: prior.startedAt,
    nextFindingId: prior.nextFindingId,
    timings: prior.timings,
    tokensByRole: prior.tokensByRole,
  };
}

async function startRecord(
  fc: FeatureContext,
  prior: WorkflowFeatureRecord | null,
  head: string | undefined,
): Promise<WorkflowFeatureRecord> {
  if (isFinishedAtHead(prior, head) && isTransientDraft(prior)) return { ...prior, step: "publish" };
  return prior && prior.step !== "done" ? resumeOrRestart(fc, prior, head) : freshRecord(fc, head);
}

function logComplete(stories: readonly StorySummary[], rec: WorkflowFeatureRecord): void {
  getSafeLogger()?.info("workflow", "Workflow complete", {
    storyId: "_run",
    outcome: rec.outcome,
    passed: rec.passed,
    ...(rec.url ? { url: rec.url } : {}),
    reasons: rec.reasons,
    stories: Object.fromEntries(stories.map((s) => [s.id, s.state])),
  });
}

function logHandOff(stories: readonly StorySummary[], storiesDurationMs: number | undefined): void {
  const ran = stories.filter((s) => s.state !== "not-run").length;
  const took = storiesDurationMs === undefined ? "" : ` (${formatDuration(storiesDurationMs)})`;
  logWorkflow(FEATURE_SCOPE, `stories done ${ran}/${stories.length}${took} - feature workflow start`);
}

/**
 * Only transport failures and a pending CI retry publishing without spending another review at the
 * same HEAD. US-003: a pending CI keeps the PR a draft, so the draft is published again — but only
 * when that pending CI is the draft's sole reason, so a draft held for an unrelated reason is not
 * re-published on every run.
 */
function isTransientDraft(prior: WorkflowFeatureRecord): boolean {
  return (
    prior.outcome === "draft" &&
    (prior.ci === "unavailable" ||
      (prior.ci === "pending" && prior.reasons.length === 1) ||
      prior.reasons.some((reason) => reason.startsWith("PR update failed:")))
  );
}

function isFinishedAtHead(
  prior: WorkflowFeatureRecord | null,
  head: string | undefined,
): prior is WorkflowFeatureRecord {
  const done = prior?.outcome === "ready" || prior?.outcome === "draft" || prior?.outcome === "pushed";
  // nax#2550: an unreadable HEAD (undefined) or an empty recorded one matches nothing.
  return prior?.step === "done" && head !== undefined && head !== "" && prior.head === head && done;
}

async function runInContext(
  fc: FeatureContext,
  input: WorkflowFeatureInput,
  meter: TokenMeter,
): Promise<WorkflowFeatureResult> {
  await ensureLedger(fc.runDir, fc.runId, fc.feature);
  const stories = summariseStories(fc.prd, await collectStoryRecords(fc.featureDir));
  const prior = await loadPriorFeature(fc.featureDir, fc.runId);
  const head = await currentHead(fc);
  if (isFinishedAtHead(prior, head) && !isTransientDraft(prior)) {
    // nax#2550: the prior `passed` described the stories of that run; the verdict is the current ones'.
    const current = {
      ...prior,
      passed: featurePassed({ ...(prior.finalGates ? { finalGates: prior.finalGates } : {}), stories }),
    };
    input.statusWriter?.setWorkflowStatus?.(workflowStatusBlock(stories, "done", current));
    getSafeLogger()?.info("workflow", "Feature workflow already finished at this HEAD — skipped", {
      storyId: "_run",
      ...(prior.url ? { url: prior.url } : {}),
    });
    return { ...resultOf(current), outcome: "already-finished" };
  }
  const record = await startRecord(fc, prior, head);
  logHandOff(stories, input.storiesDurationMs);
  const env = buildFeatureEnv(fc, input, {
    stories,
    ledgerItems: await collectLedgerItems(fc.featureDir),
    record,
    meter,
    preflight: await newestPreflight(fc.featureDir),
    specPath: await specPathFor(fc.feature, fc.projectDir),
  });
  // US-003: preparation succeeded and `record.step` is where the machine will start — the resumed
  // step when there is one. Emitted here, immediately before the machine, and never on the
  // already-finished, dry-run or aborted returns above.
  pipelineEventBus.emit({ type: "workflow:started", step: record.step });
  const final = await _featureRunDeps.runFeatureMachine(env);
  logComplete(stories, final);
  pipelineEventBus.emit(publishedEvent(final));
  return resultOf(final);
}
