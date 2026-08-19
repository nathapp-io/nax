/**
 * `runFinishPhase` — the post-run phase that drives the finish machine.
 *
 * The module design section 4.1 calls for and the only thing in `src/finish/`
 * that knows about the runner. It assembles what the machine needs from the
 * live run context (audit target, forge kind, `CallContext`, config), drives
 * `runFinishMachine`, books the cost delta and notifies.
 *
 * Fail-open by contract. `runFinishMachine` already routes every internal
 * failure to `ops.escalate` (I7), so a throw reaching here means the phase
 * could not be *set up* — a context load that threw past its own catch, or a
 * runtime field that was not there. Neither is a reason to fail a run whose
 * stories all passed, so this returns null and emits a failed phase instead.
 */
import { defaultForgeDeps, detectForge } from "@/forge";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { pipelineEventBus } from "@/pipeline";
import type { NaxRuntime } from "@/runtime";
import { errorMessage } from "../utils/errors";
import type { AuditTarget } from "./audit";
import { readFinishConfig } from "./config";
import type { FinishSettings } from "./config";
import { loadFinishContext } from "./context";
import { runFinishMachine } from "./machine";
import { buildEscalationMessage, buildTerminalMessage, sendTelegramNotify, telegramCreds } from "./notify";
import { createFinishOps } from "./ops-impl";
import { createFinishState } from "./state";
import type { FinishResult } from "./types";

export const _finishPhaseDeps = {
  loadFinishContext,
  detectForge,
  createFinishOps,
  runFinishMachine,
  sendTelegramNotify,
  now: () => new Date().toISOString(),
  /**
   * The cost reading, as a seam.
   *
   * Not inlined as `ctx.runtime.costAggregator.snapshot()`: asserting the
   * delta would then need a hand-built runtime fake, and
   * `check:test-as-unknown-as` is baselined at 830 and must not grow. With
   * the seam a test stubs one function and uses a real `makeTestRuntime()`.
   */
  snapshotCost: (runtime: NaxRuntime): number => runtime.costAggregator.snapshot().totalCostUsd,
};

export interface FinishPhaseContext {
  runtime: NaxRuntime;
  config: unknown;
  feature: string;
  workdir: string;
  branch: string;
  runId: string;
  agentName: string;
  abortSignal: AbortSignal;
  storySummary: { completed: number; failed: number; paused: number };
  /** Merged into the phase's status.json entry; absent in tests. */
  statusWriter?: { setPostRunPhase(phase: "finish", update: Record<string, unknown>): void };
}

/** A branch nax may open a PR from. `main`/`master` are not feature branches. */
function isFeatureBranch(branch: string): boolean {
  return branch !== "main" && branch !== "master" && branch.length > 0;
}

export function shouldRunFinish(args: {
  enabled: boolean;
  branch: string;
  storySummary: { completed: number; failed: number; paused: number };
}): boolean {
  if (!args.enabled) return false;
  const s = args.storySummary;
  if (s.completed === 0 || s.failed > 0 || s.paused > 0) return false;
  return isFeatureBranch(args.branch);
}

/**
 * The phase's own deadline: `finish.timeouts.flowMs`, combined with the run's
 * signal so either can stop it.
 *
 * `AbortSignal.any` rather than a manual listener pair, so the returned signal
 * is already aborted when the run's signal was aborted before the phase
 * started — a listener would never fire in that case.
 */
function phaseSignal(runSignal: AbortSignal, flowMs: number): { signal: AbortSignal; dispose: () => void } {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), flowMs);
  return {
    signal: AbortSignal.any([runSignal, deadline.signal]),
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Writes a `finish` status update, swallowing any throw from the writer.
 *
 * Keeps the fail-open contract: `runFinishPhase` never propagates a failure
 * from the status file — writing "running" or a terminal status is best
 * effort, logged on failure but never fatal to the run.
 */
function writeFinishStatus(ctx: FinishPhaseContext, update: Record<string, unknown>): void {
  try {
    ctx.statusWriter?.setPostRunPhase("finish", update);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish phase status write failed", { storyId: "_run", error: errorMessage(err) });
  }
}

export async function runFinishPhase(ctx: FinishPhaseContext): Promise<FinishResult | null> {
  const settings = readFinishConfig(ctx.config);
  if (!shouldRunFinish({ enabled: settings.enabled, branch: ctx.branch, storySummary: ctx.storySummary })) {
    return null;
  }

  pipelineEventBus.emit({ type: "postrun:phase:started", phase: "finish" });
  writeFinishStatus(ctx, { status: "running" });
  const startedAt = Date.now();
  const costBefore = _finishPhaseDeps.snapshotCost(ctx.runtime);
  const { signal, dispose } = phaseSignal(ctx.abortSignal, settings.timeouts.flowMs);

  let result: FinishResult | null = null;
  let failure: string | undefined;
  try {
    const context = await _finishPhaseDeps.loadFinishContext(ctx.feature, ctx.workdir);
    const audit: AuditTarget = {
      auditDir: `${ctx.runtime.outputDir}/finish-audit/${ctx.feature}`,
      runId: ctx.runId,
    };
    const state = createFinishState({
      feature: ctx.feature,
      workdir: ctx.workdir,
      branch: ctx.branch,
      runId: ctx.runId,
      base: context.base,
      specPath: context.specPath,
    });
    const forgeKind = await _finishPhaseDeps.detectForge(defaultForgeDeps, ctx.workdir);
    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(ctx.workdir),
      packageDir: ctx.workdir,
      agentName: ctx.agentName,
      featureName: ctx.feature,
      signal,
    };
    const ops = _finishPhaseDeps.createFinishOps({
      callCtx,
      forge: defaultForgeDeps,
      forgeKind,
      audit,
      models: settings.models,
      timeouts: {
        reviewMs: settings.timeouts.stepMs ?? undefined,
        fixMs: settings.timeouts.stepMs ?? undefined,
        narrativeMs: settings.timeouts.stepMs ?? undefined,
      },
      prBody: settings.prBody,
      // Telegram is the sole escalation channel only when it is both enabled
      // and actually credentialed — enabled with no token would suppress the
      // PR comment and then send nothing at all.
      preferTelegram: settings.escalate.telegram && telegramCreds(ctx.config) !== null,
      narrative: settings.narrative,
    });
    result = await _finishPhaseDeps.runFinishMachine(state, {
      context,
      ops,
      audit,
      signal,
      now: _finishPhaseDeps.now,
      timeouts: { acceptanceMs: settings.timeouts.acceptanceMs, gateMs: settings.timeouts.gateMs },
    });
  } catch (err) {
    failure = errorMessage(err);
  } finally {
    dispose();
  }

  const costUsd = _finishPhaseDeps.snapshotCost(ctx.runtime) - costBefore;
  const passed = failure === undefined && result?.status !== "escalated";
  writeFinishStatus(ctx, {
    status: passed ? "passed" : "failed",
    lastRunAt: _finishPhaseDeps.now(),
    ...(result ? { result: result.status } : {}),
    ...(result?.url ? { url: result.url } : {}),
    ...(result?.escalationReason ? { escalationReason: result.escalationReason } : {}),
  });
  if (failure) {
    // NOT carried on the event: `RunPhaseDetails`
    // (`src/plugins/extensions.ts:391-395`) is a closed union of four shapes
    // and none of them has an `error` field. Widening a union shared by every
    // post-run phase for one field is the wrong trade; the reason is already
    // durable on the status file and in the log.
    getSafeLogger()?.warn("finish", "Finish phase could not run", { storyId: "_run", error: failure });
  }
  pipelineEventBus.emit({
    type: "postrun:phase:completed",
    phase: "finish",
    passed,
    durationMs: Date.now() - startedAt,
    costUsd,
  });

  if (result) await notify(ctx, settings, result);
  return result;
}

/** Send the Telegram notification the configured mode calls for. Never throws. */
async function notify(ctx: FinishPhaseContext, settings: FinishSettings, result: FinishResult): Promise<void> {
  if (settings.notify.mode === "off") return;
  if (settings.notify.mode === "escalation" && result.status !== "escalated") return;
  const creds = telegramCreds(ctx.config);
  if (!creds) return;
  const text =
    result.status === "escalated"
      ? buildEscalationMessage(result.feature, result.escalationReason ?? "", result.findings ?? [])
      : buildTerminalMessage({ feature: result.feature, status: result.status, url: result.url });
  await _finishPhaseDeps.sendTelegramNotify(creds, text);
}
