/**
 * Finish A §3-§4: every fix session (acceptance, review, gate) runs here.
 *
 * - The fixer runs under the run's own signal (hard) plus an interrupt (soft) =
 *   phase signal + fixMs. The fix op answers an interrupt with a handoff note.
 * - Commit guard: anything that stopped is set aside, never returned as done.
 * - A crash is set aside too ("error"), so the next step starts from the base.
 * - fixMs stop -> `stopped` (the loop continues); flow / run stop -> set aside,
 *   then FINISH_ABORTED, so the handoff survives the machine's recovery path.
 * - A base that cannot be read (git fails, unsafe snapshot dir) fails the step
 *   without running the fixer.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { writeCheckpoint } from "./checkpoint";
import { setAsideLeftoverDirt } from "./finalize-dirt";
import { restorePending, restorePendingNumbers } from "./handoff-state";
import { findingId } from "./ledger";
import type { FinishOps, FixOutcome, FixPhase, FixRequest } from "./ops";
import {
  captureFixBase,
  markHandoffConsumed,
  markHandoffReapplied,
  readHandoffNote,
  reapplyHandoff,
  removeSnapshotDir,
  setAside,
  snapshotUntracked,
} from "./set-aside";
import type { FinishState } from "./state";
import { stepSignal } from "./step-signal";
import type { Finding, FixBase, FixContinuation, HandoffLimit, HandoffNote, HandoffRecord, Stop } from "./types";

export type FixStepResult =
  | { kind: "done"; outcome: FixOutcome; continued?: HandoffRecord }
  | { kind: "failed"; error: unknown; handoff?: HandoffRecord }
  | { kind: "stopped"; handoff: HandoffRecord };

export interface FixStepDeps {
  ops: FinishOps;
  audit: AuditTarget;
  now: () => string;
  /** Phase signal (run signal + flowMs deadline). */
  signal?: AbortSignal;
  /** The run's own signal (SIGINT / cancel). */
  runSignal?: AbortSignal;
  fixMs?: number;
  flowMs?: number;
}

export function findingIdsOf(findings: Finding[] | undefined): string[] {
  return (findings ?? []).map(findingId);
}

function stopKind(deps: FixStepDeps, limit: AbortSignal | undefined, outcome?: FixOutcome): HandoffLimit | undefined {
  if (deps.runSignal?.aborted) return "run";
  if (deps.signal?.aborted) return "flow";
  if (limit?.aborted || outcome?.interrupted) return "fix";
  return undefined;
}

function limitMsFor(deps: FixStepDeps, limit: HandoffLimit): number {
  if (limit === "flow") return deps.flowMs ?? 0;
  if (limit === "fix") return deps.fixMs ?? 0;
  return 0;
}

function stopFor(
  deps: FixStepDeps,
  ctx: { phase: FixPhase; req: Pick<FixRequest, "findings">; limit: Exclude<HandoffLimit, "error">; round: number },
  record: HandoffRecord,
): Stop {
  return {
    kind: ctx.limit,
    phase: ctx.phase,
    at: deps.now(),
    limitMs: limitMsFor(deps, ctx.limit),
    handoff: record.n,
    ...(ctx.phase === "review" ? { findings: ctx.req.findings?.length ?? 0, round: ctx.round } : {}),
  };
}

interface AsideCtx {
  phase: FixPhase;
  base: FixBase;
  req: Pick<FixRequest, "findings">;
  limit: HandoffLimit;
  note?: HandoffNote;
}

async function setAsideStep(state: FinishState, deps: FixStepDeps, ctx: AsideCtx): Promise<HandoffRecord> {
  const record = await setAside({
    workdir: state.workdir,
    audit: deps.audit,
    n: state.handoffs.length + 1,
    base: ctx.base,
    phase: ctx.phase,
    limit: ctx.limit,
    findingIds: findingIdsOf(ctx.req.findings),
    ...(ctx.note ? { note: ctx.note } : {}),
    now: deps.now,
  });
  state.handoffs = [...state.handoffs, record];
  if (ctx.limit === "fix" || ctx.limit === "flow") state.pendingHandoff = record.n;
  if (ctx.limit !== "error") {
    state.stops = [
      ...state.stops,
      stopFor(deps, { phase: ctx.phase, req: ctx.req, limit: ctx.limit, round: state.review.rounds }, record),
    ];
  }
  getSafeLogger()?.warn("finish", "Fix session set aside", {
    storyId: "_run",
    phase: ctx.phase,
    limit: ctx.limit,
    restored: record.restored,
    handoff: record.dir,
  });
  return record;
}

function abortIfPhaseStopped(deps: FixStepDeps): void {
  if (deps.signal?.aborted || deps.runSignal?.aborted) {
    throw new NaxError("Finish aborted mid-loop", "FINISH_ABORTED", { stage: "finish" });
  }
}

/** The base the session starts from, or the reason it cannot (a failed step, never a crash). */
async function captureBase(state: FinishState, deps: FixStepDeps): Promise<FixBase | { error: unknown }> {
  try {
    const captured = await captureFixBase(state.workdir, deps.audit.auditDir);
    if (!captured) {
      return { error: new NaxError("Cannot read the worktree base", "FINISH_FIX_BASE", { stage: "finish" }) };
    }
    // Only the nax audit directory is ever cleared and written: never a user-derived path.
    // One directory per prospective handoff number: a later session must not clear the snapshot
    // an earlier, restore-failed handoff still needs at finalize.
    const snapshotDir = join(deps.audit.auditDir, `${deps.audit.runId}.fix-base-${state.handoffs.length + 1}`);
    return {
      ...captured,
      untrackedSnapshot: await snapshotUntracked(state.workdir, captured.untrackedBefore, snapshotDir),
    };
  } catch (error) {
    getSafeLogger()?.warn("finish", "Fix step could not capture its base", {
      storyId: "_run",
      error: errorMessage(error),
    });
    return { error };
  }
}

function replaceHandoff(state: FinishState, next: HandoffRecord): void {
  state.handoffs = state.handoffs.map((h) => (h.n === next.n ? next : h));
}

/** A re-apply that throws is a re-apply that did not happen: the attempt starts from scratch. */
async function safeReapply(workdir: string, pending: HandoffRecord): Promise<{ applied: boolean; files: string[] }> {
  try {
    return await reapplyHandoff(workdir, pending);
  } catch (error) {
    getSafeLogger()?.warn("finish", "Handoff re-apply threw; fix attempt starts from scratch", {
      storyId: "_run",
      handoff: pending.dir,
      error: errorMessage(error),
    });
    return { applied: false, files: [] };
  }
}

/** 4.3: the pending stopped handoff of this phase, re-applied; undefined when none or it no longer applies. */
async function continueFrom(
  state: FinishState,
  phase: FixPhase,
): Promise<{ record: HandoffRecord; continuation: FixContinuation } | undefined> {
  const pending = state.handoffs.find((h) => h.n === state.pendingHandoff);
  if (!pending || pending.phase !== phase) return undefined;
  state.pendingHandoff = undefined;
  const { applied, files } = await safeReapply(state.workdir, pending);
  const record = await markHandoffReapplied(pending, applied);
  replaceHandoff(state, record);
  if (!applied) {
    getSafeLogger()?.warn("finish", "Handoff no longer applies; fix attempt starts from scratch", {
      storyId: "_run",
      phase,
      handoff: pending.dir,
    });
    return undefined;
  }
  const note = await readHandoffNote(record);
  return { record, continuation: { files, ...(note ? { note } : {}) } };
}

/** A continued attempt that committed has used up its handoff. */
export async function consumeIfCommitted(
  state: FinishState,
  continued: HandoffRecord | undefined,
  committed: boolean,
): Promise<void> {
  if (!continued || !committed) return;
  replaceHandoff(state, await markHandoffConsumed(continued));
}

/** §4.4: the step is complete, so the state is checkpointed. Never throws, so it cannot mask a later FINISH_ABORTED. */
async function checkpointed(state: FinishState, deps: FixStepDeps, result: FixStepResult): Promise<FixStepResult> {
  await writeCheckpoint(deps.audit, state);
  return result;
}

/**
 * The base's snapshot holds copies of the user's untracked files (possibly secrets), so it lives only as
 * long as something can still need it: until the step settles, or until finalize for a handoff whose
 * restore failed.
 */
async function settleSnapshot(deps: FixStepDeps, base: FixBase, handoff?: HandoffRecord): Promise<void> {
  if (handoff && !handoff.restored) return;
  await removeSnapshotDir(deps.audit.auditDir, base.untrackedSnapshot);
}

/**
 * A restore-failed handoff still leaves its half-edit in the worktree. The next fixer must not start (and
 * the next commit must not run `git add -A`) on top of it: set it aside first, with that session's own base,
 * exactly as finalize does. Undefined when the step may go on; otherwise the reason it cannot.
 */
async function blockedByRestoreFailure(state: FinishState, deps: FixStepDeps): Promise<NaxError | undefined> {
  if (!state.handoffs.some(restorePending)) return undefined;
  try {
    // A clean tree returns false: nothing to set aside.
    if (!(await setAsideLeftoverDirt(state, deps.audit))) return undefined;
  } catch (error) {
    getSafeLogger()?.warn("finish", "Leftover set-aside threw before a fix step", {
      storyId: "_run",
      error: errorMessage(error),
    });
  }
  const pending = restorePendingNumbers(state.handoffs).map((n) => `handoff-${n}`);
  getSafeLogger()?.warn("finish", "Fix step skipped: an unrestored set-aside still leaves work in the worktree", {
    storyId: "_run",
    handoffs: pending,
  });
  return new NaxError(
    `Fix step skipped: the worktree still holds the half-edit of ${pending.join(", ")}`,
    "FINISH_RESTORE_BLOCKED",
    { stage: "finish", handoffs: pending },
  );
}

export async function runFixStep(
  state: FinishState,
  deps: FixStepDeps,
  phase: FixPhase,
  req: Omit<FixRequest, "state" | "interrupt" | "continuation">,
): Promise<FixStepResult> {
  abortIfPhaseStopped(deps);
  const blocked = await blockedByRestoreFailure(state, deps);
  if (blocked) return checkpointed(state, deps, { kind: "failed", error: blocked });
  const captured = await captureBase(state, deps);
  if ("error" in captured) return checkpointed(state, deps, { kind: "failed", error: captured.error });
  const base = captured;
  state.lastFixBase = base;
  // After the base is captured, so stopping again also sets the re-applied edits aside.
  const cont = await continueFrom(state, phase);
  const { signal: interrupt, limit } = stepSignal(deps.signal, deps.fixMs);
  let outcome: FixOutcome;
  try {
    outcome = await deps.ops.fix(phase, {
      ...req,
      state,
      ...(interrupt ? { interrupt } : {}),
      ...(cont ? { continuation: cont.continuation } : {}),
    });
  } catch (error) {
    // Any throw after the step limit fired is treated as a `fix` stop, whatever its message.
    const kind = stopKind(deps, limit) ?? "error";
    const handoff = await setAsideStep(state, deps, { phase, base, req, limit: kind });
    await settleSnapshot(deps, base, handoff);
    if (kind === "error") return checkpointed(state, deps, { kind: "failed", error, handoff });
    await writeCheckpoint(deps.audit, state);
    abortIfPhaseStopped(deps);
    return { kind: "stopped", handoff };
  }
  const kind = stopKind(deps, limit, outcome);
  if (!kind) {
    await settleSnapshot(deps, base);
    return checkpointed(state, deps, { kind: "done", outcome, ...(cont ? { continued: cont.record } : {}) });
  }
  const handoff = await setAsideStep(state, deps, {
    phase,
    base,
    req,
    limit: kind,
    ...(outcome.handoffNote ? { note: outcome.handoffNote } : {}),
  });
  await settleSnapshot(deps, base, handoff);
  await writeCheckpoint(deps.audit, state);
  abortIfPhaseStopped(deps);
  return { kind: "stopped", handoff };
}
