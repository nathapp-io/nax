/**
 * ADR-022 — strategy dispatch, from correlation id to `FixApplied`.
 *
 * Extracted from `runFixCycle`'s strategy loop so the dispatch's accounting
 * lives beside the ledger read it depends on (cycle-cost.ts) rather than in the
 * middle of the cycle's control flow. Three concerns meet here and nowhere
 * else:
 *
 * - the per-dispatch correlation id (#1932), which is what makes the spend
 *   findable afterwards — minted by the caller and threaded through here, so
 *   this module needs no import back into `@/operations` and stays a leaf;
 * - the per-strategy session override (#1654);
 * - both halves of the spend, successful and failed (#1948).
 *
 * Two granularities live here:
 *
 * - `dispatchStrategy` runs ONE strategy and throws exactly what the dispatch
 *   throws, having first recorded what that attempt burned;
 * - `dispatchGroup` (US-003) runs one iteration's strategy group and converts a
 *   `CALL_OP_NO_DISPATCH` throw into the cycle's zero-dispatch exit — no hop of
 *   that operation reached a model, so the iteration is not validated, and it is
 *   recorded with the failed dispatch's spend, marked `noDispatch` so the
 *   no-progress bail can skip it.
 */

import type { Logger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import { NaxError } from "../errors";
import { ledgerSpendFor } from "./cycle-cost";
import { recordIteration } from "./cycle-iteration-log";
import type {
  CallOpFn,
  FixApplied,
  FixCycle,
  FixCycleContext,
  FixCycleResult,
  FixStrategy,
  Iteration,
} from "./cycle-types";
import type { Finding } from "./types";

/** Correlation triple every `findings.cycle` log line carries. */
export interface DispatchLogContext {
  storyId: string;
  packageDir?: string;
  cycleName: string;
}

/**
 * Run one strategy's fix op and describe what it did.
 *
 * @throws whatever the dispatch throws, unchanged — after logging the spend.
 *   A `CALL_OP_NO_DISPATCH` throw is converted by `dispatchGroup` into the
 *   cycle's zero-dispatch exit (US-003), which records the failed dispatch's
 *   spend on the iteration. Every other error still escapes `runFixCycle`
 *   entirely, so no iteration is recorded and no `FixApplied` survives to carry
 *   the number; that log line is then the only channel left, and it is the one
 *   the curator collects from (#1948).
 */
export async function dispatchStrategy<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  strategy: FixStrategy<F, any, any, any>,
  ctx: FixCycleContext,
  findingsBefore: F[],
  priorIterations: Iteration<F>[],
  deps: {
    callOp: CallOpFn;
    /**
     * #1932: a fresh correlation id per dispatch, stamped rather than left for
     * `callOp` to mint, so this layer can find the dispatch's rows in the cost
     * ledger afterwards. See cycle-cost.ts for why a callId and not a cost scope.
     */
    dispatchCallId: string;
    logger: Logger | null | undefined;
    logCtx: DispatchLogContext;
  },
): Promise<FixApplied> {
  const { dispatchCallId } = deps;
  const relevantFindings = findingsBefore.filter((f) => strategy.appliesTo(f));
  const input = strategy.buildInput(relevantFindings, priorIterations, ctx);
  const fixCtx: FixCycleContext = {
    ...ctx,
    callId: dispatchCallId,
    fixStrategy: { name: strategy.name, findingsBefore: findingsBefore.length },
    // #1654: a strategy may run under its own session role, which gives it a
    // session of its own rather than continuing the one the previous strategy
    // used. `callOp` resolves `sessionOverride.role ?? op.session.role`, so this
    // isolates the dispatch without the op having to be duplicated.
    ...(strategy.sessionRole ? { sessionOverride: { role: strategy.sessionRole } } : {}),
  };

  let output: unknown;
  try {
    output = await deps.callOp(fixCtx, strategy.fixOp, input);
  } catch (err) {
    // Telemetry, not recovery — the error is rethrown untouched.
    const spend = ledgerSpendFor(fixCtx, dispatchCallId);
    deps.logger?.warn("findings.cycle", "dispatch threw — spend recorded here, not on an iteration", {
      ...deps.logCtx,
      strategyName: strategy.name,
      op: strategy.fixOp.name,
      callId: dispatchCallId,
      costUsd: spend.costUsd,
      errorCostUsd: spend.errorCostUsd,
      error: errorMessage(err),
    });
    throw err;
  }

  const extracted = await (strategy.extractApplied?.(output, input) ?? {});
  // #1932/#1960: the ledger read below already folds the failed half into
  // `costUsd`. How an explicit `extractApplied.costUsd` interacts with that
  // fold is the override further down.
  const spend = ledgerSpendFor(fixCtx, dispatchCallId);
  return {
    strategyName: strategy.name,
    op: strategy.fixOp.name,
    targetFiles: extracted.targetFiles ?? [],
    summary: extracted.summary ?? "",
    ...(extracted.unresolved ? { unresolved: extracted.unresolved } : {}),
    // A strategy that reports its own cost knows what its successful call
    // billed, not what the attempts that threw before it burned -- so the
    // ledger's failed half is added on top of an override rather than replaced.
    // `spend.costUsd` already includes that half, so the non-override branch
    // needs no addition.
    costUsd: extracted.costUsd !== undefined ? extracted.costUsd + spend.errorCostUsd : spend.costUsd,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  };
}

// ─── Iteration-level dispatch (US-003) ───────────────────────────────────────

/**
 * The error code `callOp` raises for an operation whose hops never reached a
 * model. Spelled here because this module is where the fix cycle reads it:
 * `src/operations/call.ts` writes the same literal, and
 * `src/review/no-dispatch.ts` is the review side's reader.
 */
const NO_DISPATCH_ERROR_CODE = "CALL_OP_NO_DISPATCH";

/** Is `err` the zero-dispatch error `callOp` raises when no hop reached a model? */
export function isNoDispatchError(err: unknown): boolean {
  return err instanceof NaxError && err.code === NO_DISPATCH_ERROR_CODE;
}

/** One iteration's dispatch outcome: the fixes the group applied, or the zero-dispatch exit. */
export type GroupDispatchOutcome<F extends Finding> =
  | { kind: "dispatched"; fixesApplied: FixApplied[]; startedAt: string }
  | { kind: "no-dispatch"; result: FixCycleResult<F> };

export interface GroupDispatchInput<F extends Finding> {
  /** Strategies selected for this iteration, in execution order. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  strategies: FixStrategy<F, any, any, any>[];
  /** The cycle whose `iterations` the zero-dispatch exit appends to. */
  cycle: FixCycle<F>;
  ctx: FixCycleContext;
  /** Findings this iteration starts with; the zero-dispatch exit keeps them. */
  findingsBefore: F[];
  /** Cycle spend accumulated before this iteration — folded into the zero-dispatch result. */
  spentBeforeUsd: number;
  deps: {
    callOp: CallOpFn;
    /**
     * Fresh correlation id per dispatch (#1932). Injected rather than imported
     * so this module keeps no `@/operations` edge — the cycle's own import
     * already owns that boundary, and adding one here would pull this leaf
     * into a runtime import cycle.
     */
    newCallId: () => string;
    logger: Logger | null | undefined;
    /**
     * The correlation triple every `findings.cycle` line carries. Typed as the
     * dispatch context (`storyId` required) because `dispatchStrategy` logs with
     * it; it widens to `RecordIterationContext` for the iteration record.
     */
    logCtx: DispatchLogContext;
    now: () => string;
  };
}

/**
 * Run one iteration's strategy group.
 *
 * Dispatches every strategy in order, collecting its `FixApplied`. A
 * `CALL_OP_NO_DISPATCH` throw ends the iteration through the zero-dispatch exit:
 * no hop of that operation reached a model, so nothing on disk changed and
 * there is nothing for `validate` to judge; the iteration is recorded (with the
 * failed dispatch's spend, marked `noDispatch`) so its cost survives and the
 * no-progress bail can skip it.
 *
 * The conversion applies only while nothing in the group has applied a fix. A
 * sibling that did edit the tree keeps the old behaviour — the error propagates
 * and the pass fails loudly — because skipping revalidation of its edits is not
 * ours to decide.
 */
export async function dispatchGroup<F extends Finding>(input: GroupDispatchInput<F>): Promise<GroupDispatchOutcome<F>> {
  const { strategies, cycle, ctx, findingsBefore, deps } = input;
  const startedAt = deps.now();
  const fixesApplied: FixApplied[] = [];

  for (const strategy of strategies) {
    const dispatchCallId = deps.newCallId();
    try {
      fixesApplied.push(
        await dispatchStrategy(strategy, ctx, findingsBefore, cycle.iterations, {
          callOp: deps.callOp,
          dispatchCallId,
          logger: deps.logger,
          logCtx: deps.logCtx,
        }),
      );
    } catch (err) {
      if (fixesApplied.length > 0 || !isNoDispatchError(err)) throw err;
      return {
        kind: "no-dispatch",
        result: zeroDispatchExit({
          cycle,
          ctx,
          findingsBefore,
          strategy,
          callId: dispatchCallId,
          spentBeforeUsd: input.spentBeforeUsd,
          startedAt,
          finishedAt: deps.now(),
          logCtx: deps.logCtx,
          logger: deps.logger,
        }),
      };
    }
  }

  return { kind: "dispatched", fixesApplied, startedAt };
}

/**
 * Build the cycle's zero-dispatch exit, recording the iteration it belongs to.
 *
 * The failed dispatch still counts as an attempt — `fixesApplied` carries it,
 * with the spend the ledger recorded against its callId — so the attempt caps
 * and the story-scoped budget see the invocation that was made. `findingsAfter`
 * stays equal to `findingsBefore`: validation was skipped because nothing ran.
 */
function zeroDispatchExit<F extends Finding>(input: {
  cycle: FixCycle<F>;
  ctx: FixCycleContext;
  findingsBefore: F[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  strategy: FixStrategy<F, any, any, any>;
  callId: string;
  spentBeforeUsd: number;
  startedAt: string;
  finishedAt: string;
  logCtx: DispatchLogContext;
  logger: Logger | null | undefined;
}): FixCycleResult<F> {
  const { strategy, callId } = input;
  const spend = ledgerSpendFor(input.ctx, callId);
  const failedDispatch: FixApplied = {
    strategyName: strategy.name,
    op: strategy.fixOp.name,
    targetFiles: [],
    summary: "",
    costUsd: spend.costUsd,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  };
  const iteration = recordIteration(
    input.cycle,
    {
      findingsBefore: input.findingsBefore,
      findingsAfter: input.findingsBefore,
      fixesApplied: [failedDispatch],
      outcome: "unchanged",
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      noDispatch: true,
    },
    input.logCtx,
    input.logger,
  );

  input.logger?.warn("findings.cycle", "cycle exited — dispatch reached no model", {
    ...input.logCtx,
    reason: "no-dispatch",
    strategyName: strategy.name,
    op: strategy.fixOp.name,
    callId,
    costUsd: spend.costUsd,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  });

  return {
    iterations: input.cycle.iterations,
    finalFindings: input.cycle.findings,
    exitReason: "no-dispatch",
    costUsd: input.spentBeforeUsd + (iteration.costUsd ?? 0),
  };
}
