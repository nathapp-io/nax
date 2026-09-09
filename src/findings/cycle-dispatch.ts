/**
 * ADR-022 — one strategy dispatch, from correlation id to `FixApplied`.
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
 * Behaviour is unchanged by the extraction: this throws exactly what the
 * dispatch throws, having first recorded what that attempt burned.
 */

import type { Logger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import { ledgerSpendFor } from "./cycle-cost";
import type { CallOpFn, FixApplied, FixCycleContext, FixStrategy, Iteration } from "./cycle-types";
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
 *   The throw escapes `runFixCycle` entirely, so no iteration is ever recorded
 *   and no `FixApplied` survives to carry the number; that log line is the only
 *   channel left, and it is the one the curator collects from (#1948).
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
  // #1932/#1948: read both halves of the dispatch's real spend. An explicit
  // `extractApplied.costUsd` still wins for the successful half — but only that
  // half: a strategy that knows its own cost knows what its successful call
  // billed, not what the attempts that threw before it burned, so the ledger
  // remains the only source for `errorCostUsd`.
  const spend = ledgerSpendFor(fixCtx, dispatchCallId);
  return {
    strategyName: strategy.name,
    op: strategy.fixOp.name,
    targetFiles: extracted.targetFiles ?? [],
    summary: extracted.summary ?? "",
    ...(extracted.unresolved ? { unresolved: extracted.unresolved } : {}),
    costUsd: extracted.costUsd ?? spend.costUsd,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  };
}
