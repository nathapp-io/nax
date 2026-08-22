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

/** Which clause of the gate blocked the phase, or `null` when it did not. */
export type FinishSkipReason = "enabled" | "completed" | "failed" | "paused" | "branch";

/**
 * The gate, split out from `shouldRunFinish` so a caller can log or record
 * *which* clause blocked the phase (#1671) rather than only that one did.
 *
 * Order matters and is preserved from the original single boolean check:
 * `enabled` is checked first (the phase is off, full stop), then the story
 * summary's three fields in the order they were originally `||`'d together,
 * then the branch. A run that fails more than one clause reports only the
 * first — good enough for a log line; nothing downstream needs the full set.
 */
export function finishSkipReason(args: {
  enabled: boolean;
  branch: string;
  storySummary: { completed: number; failed: number; paused: number };
}): FinishSkipReason | null {
  if (!args.enabled) return "enabled";
  const s = args.storySummary;
  if (s.completed === 0) return "completed";
  if (s.failed > 0) return "failed";
  if (s.paused > 0) return "paused";
  if (!isFeatureBranch(args.branch)) return "branch";
  return null;
}

/**
 * Thin boolean wrapper over `finishSkipReason`, kept for every existing
 * caller and test that only needs "does the phase run" — most notably
 * `test/unit/finish/phase.test.ts`'s `completed: 0` case, which must keep
 * passing unchanged.
 */
export function shouldRunFinish(args: {
  enabled: boolean;
  branch: string;
  storySummary: { completed: number; failed: number; paused: number };
}): boolean {
  return finishSkipReason(args) === null;
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
  const skipReason = finishSkipReason({
    enabled: settings.enabled,
    branch: ctx.branch,
    storySummary: ctx.storySummary,
  });
  if (skipReason) {
    // The disabled case is not recorded on status.json (only logged): writing
    // a `finish` key there for every finish-disabled run would add that key
    // for all consumers, which is a wider behaviour change than the #1671
    // gate fix warrants. Every other clause is both logged and recorded —
    // those runs already have `finish.enabled: true`, so a `finish` status
    // entry is expected there regardless.
    getSafeLogger()?.info("finish", "Finish phase skipped — gate did not pass", {
      storyId: "_run",
      reason: skipReason,
    });
    if (skipReason !== "enabled") {
      writeFinishStatus(ctx, { status: "skipped", reason: skipReason });
    }
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
    // Resolved before `loadFinishContext` so the ledger's entry check
    // (#1674 part 1) can read `last.json` from the exact directory this run
    // will later write it to.
    const audit: AuditTarget = {
      auditDir: `${ctx.runtime.outputDir}/finish-audit/${ctx.feature}`,
      runId: ctx.runId,
    };
    const context = await _finishPhaseDeps.loadFinishContext(ctx.feature, ctx.workdir, {
      branch: ctx.branch,
      auditDir: audit.auditDir,
      rerun: settings.rerun,
    });
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
      // Telegram is the sole escalation channel only when it is enabled,
      // actually credentialed, AND notifications are not switched off —
      // `preferTelegram` suppresses the PR comment, and `notify()` below
      // sends nothing when `notify.mode` is "off", so dropping any one of
      // these three conjuncts delivers the escalation precisely nowhere.
      // The acpx plugin this replaced tested all three together; the port
      // originally kept only two.
      preferTelegram:
        settings.notify.mode !== "off" && settings.escalate.telegram && telegramCreds(ctx.config) !== null,
      narrative: settings.narrative,
    });
    result = await _finishPhaseDeps.runFinishMachine(state, {
      context,
      ops,
      audit,
      signal,
      // The run's own signal, so the machine can tell a cancelled run (do not
      // push or post) from a `flowMs` deadline (do escalate) — `signal` above
      // carries both and cannot distinguish them.
      runSignal: ctx.abortSignal,
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
  if (result?.skipReason === "already-finished") {
    // #1674 part 1: the ledger already covers this exact HEAD — the machine
    // did no real work beyond the entry check. Reported distinctly from the
    // ordinary "passed" path so a consumer of status.json can tell "this run
    // did nothing because there was nothing new" from "this run did the
    // work and it passed".
    getSafeLogger()?.info("finish", "Finish phase skipped — already finished at this HEAD", {
      storyId: "_run",
      feature: result.feature,
      ...(result.url ? { url: result.url } : {}),
    });
    writeFinishStatus(ctx, {
      status: "skipped",
      reason: result.skipReason,
      lastRunAt: _finishPhaseDeps.now(),
      ...(result.url ? { url: result.url } : {}),
    });
  } else {
    writeFinishStatus(ctx, {
      status: passed ? "passed" : "failed",
      lastRunAt: _finishPhaseDeps.now(),
      ...(result ? { result: result.status } : {}),
      ...(result?.url ? { url: result.url } : {}),
      ...(result?.escalationReason ? { escalationReason: result.escalationReason } : {}),
      ...(result?.deliveryError ? { deliveryError: result.deliveryError } : {}),
    });
  }
  // An escalation nobody received is the worst outcome this phase has: the run
  // stopped for a human who was never told. The plugin this replaced logged it
  // and failed its action; the phase cannot fail a run, so the log and the
  // status entry above are the whole signal.
  if (result?.deliveryError) {
    getSafeLogger()?.warn("finish", "Finish escalated but the escalation was not delivered", {
      storyId: "_run",
      feature: result.feature,
      error: result.deliveryError,
      escalationReason: result.escalationReason,
    });
  }
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
  // The boolean matters: a `false` means Telegram rejected the message, and on
  // an escalation Telegram is the ONLY channel (`preferTelegram` suppressed the
  // PR comment). Discarding it turned a dropped page into silence.
  const delivered = await _finishPhaseDeps.sendTelegramNotify(creds, text);
  if (!delivered) {
    getSafeLogger()?.warn("finish", "Finish Telegram notification was not delivered", {
      storyId: "_run",
      feature: result.feature,
      status: result.status,
    });
  }
}
