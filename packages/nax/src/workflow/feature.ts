/**
 * runWorkflowFeature (spec §7): after the last story, one feature workflow — repo gates,
 * one branch review, one branch fix, one re-review, adjudication, gates again, then publish.
 * Resumes an unfinished prior record; skips when already finished at this HEAD (P4-R1).
 */
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";
import { FEATURE_SCOPE } from "./advisor-live";
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
import { readHead } from "./git";
import { appendLedger, ensureLedger, ledgerText } from "./ledger";
import { collectLedgerItems } from "./ledger-items";
import { logWorkflow } from "./run-log";
import { resolveSeed } from "./seed";
import { workflowStatusBlock } from "./status-block";
import { startTokenMeter, type TokenMeter } from "./tokens";
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

async function startRecord(fc: FeatureContext, prior: WorkflowFeatureRecord | null): Promise<WorkflowFeatureRecord> {
  if (prior && prior.step !== "done") {
    await appendLedger(fc.runDir, "_run", ledgerText.note(`resumed the feature workflow at ${prior.step}`));
    return prior;
  }
  return newFeatureRecord({
    now: new Date().toISOString(),
    seed: await resolveSeed(fc.projectDir, fc.prd),
    minors: minorsFrom((await collectLedgerItems(fc.featureDir)).deferredMinors),
  });
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

/** Ready and draft are published; a local-only prior published nothing, so it runs again (P4-R1 ruling). */
function isFinishedAtHead(prior: WorkflowFeatureRecord | null, head: string): prior is WorkflowFeatureRecord {
  return prior?.step === "done" && prior.head === head && (prior.outcome === "ready" || prior.outcome === "draft");
}

async function runInContext(
  fc: FeatureContext,
  input: WorkflowFeatureInput,
  meter: TokenMeter,
): Promise<WorkflowFeatureResult> {
  await ensureLedger(fc.runDir, fc.runId, fc.feature);
  const stories = summariseStories(fc.prd, await collectStoryRecords(fc.featureDir));
  const prior = await loadPriorFeature(fc.featureDir, fc.runId);
  if (isFinishedAtHead(prior, await readHead(fc.projectDir))) {
    input.statusWriter?.setWorkflowStatus?.(workflowStatusBlock(stories, "done", prior));
    getSafeLogger()?.info("workflow", "Feature workflow already finished at this HEAD — skipped", {
      storyId: "_run",
      ...(prior.url ? { url: prior.url } : {}),
    });
    return { ...resultOf(prior), outcome: "already-finished" };
  }
  const record = await startRecord(fc, prior);
  logHandOff(stories, input.storiesDurationMs);
  const env = buildFeatureEnv(fc, input, {
    stories,
    ledgerItems: await collectLedgerItems(fc.featureDir),
    record,
    meter,
    preflight: await newestPreflight(fc.featureDir),
    specPath: await specPathFor(fc.feature, fc.projectDir),
  });
  const final = await _featureRunDeps.runFeatureMachine(env);
  logComplete(stories, final);
  return resultOf(final);
}
