/**
 * US-005 — the optional `beforeDispatch` dispatch hook on `FixStrategy`
 * (`src/findings/cycle-dispatch.ts`).
 *
 * AC1 — `dispatchStrategy` awaits the strategy's `beforeDispatch` before it
 *       calls `callOp`.
 * AC2 — for a strategy without `beforeDispatch`, `dispatchStrategy` calls
 *       `callOp` once, exactly as before.
 *
 * The hook exists so a strategy can prepare state the dispatch depends on (the
 * blocking cycle's `autofix-test-writer` snapshots the working tree with it).
 * "Awaits" is the load-bearing word: a fire-and-forget call would let the fix
 * edit the tree before the snapshot was taken, which is the one thing the hook
 * is there to prevent.
 */
import { describe, expect, test } from "bun:test";
import type { DispatchLogContext } from "@/findings/cycle-dispatch";
import { dispatchStrategy } from "@/findings/cycle-dispatch";
import type { CallOpFn, FixApplied, FixCycleContext } from "@/findings/cycle-types";
import type { Logger } from "@/logger";
import { lintA, makeCallOpMock, makeCtx, makeStrategy } from "./_cycle-fixtures";

/** The `dispatchStrategy` dependency bundle, with a `callOp` the caller controls. */
interface DispatchDeps {
  callOp: CallOpFn;
  dispatchCallId: string;
  logger: Logger | null;
  logCtx: DispatchLogContext;
}

function dispatchDeps(callOp: CallOpFn): DispatchDeps {
  return {
    callOp,
    dispatchCallId: "call-1",
    logger: null,
    logCtx: { storyId: "story-1", cycleName: "test-cycle", packageDir: "/tmp/test" },
  };
}

describe("dispatchStrategy — the beforeDispatch hook (US-005 AC1)", () => {
  test("US-005 AC1: beforeDispatch completes before callOp is invoked", async () => {
    const order: string[] = [];
    const hookCtxs: FixCycleContext[] = [];
    const callOp = makeCallOpMock((call) => {
      order.push(`callOp:${call.opName}`);
      return { applied: true };
    });
    const strategy = makeStrategy({
      name: "autofix-test-writer",
      beforeDispatch: async (hookCtx) => {
        // A hook that has not been awaited would resolve on a later tick, so its
        // own record lands after the dispatch's.
        await Promise.resolve();
        hookCtxs.push(hookCtx);
        order.push("beforeDispatch");
      },
    });

    const applied = await dispatchStrategy(strategy, makeCtx(), [lintA], [], dispatchDeps(callOp));

    expect(order).toEqual(["beforeDispatch", "callOp:noop-op"]);
    expect(callOp).toHaveBeenCalledTimes(1);
    expect(applied.strategyName).toBe("autofix-test-writer");
  });

  test("US-005 AC1 boundary: beforeDispatch receives a context for this dispatch's story and package dir", async () => {
    const hookCtxs: FixCycleContext[] = [];
    const callOp = makeCallOpMock({ applied: true });
    const strategy = makeStrategy({
      name: "autofix-test-writer",
      beforeDispatch: async (hookCtx) => {
        hookCtxs.push(hookCtx);
      },
    });
    const ctx = makeCtx();

    await dispatchStrategy(strategy, ctx, [lintA], [], dispatchDeps(callOp));

    // The hook needs the dispatch's own coordinates to snapshot the right tree —
    // a hook handed an unrelated or partial context cannot do its job.
    expect(hookCtxs).toHaveLength(1);
    expect(hookCtxs[0]?.storyId).toBe("story-1");
    expect(hookCtxs[0]?.packageDir).toBe(ctx.packageDir);
  });

  test("US-005 AC1 boundary: a rejecting beforeDispatch surfaces and the dispatch never runs", async () => {
    const callOp = makeCallOpMock({ applied: true });
    const strategy = makeStrategy({
      name: "autofix-test-writer",
      beforeDispatch: async () => {
        throw new Error("[fix-review] snapshot failed");
      },
    });

    await expect(dispatchStrategy(strategy, makeCtx(), [lintA], [], dispatchDeps(callOp))).rejects.toThrow(
      "[fix-review] snapshot failed",
    );
    // Awaited means awaited: the failure is not swallowed and no agent turn is
    // spent on a dispatch whose preparation failed.
    expect(callOp).not.toHaveBeenCalled();
  });
});

describe("dispatchStrategy — a strategy without beforeDispatch (US-005 AC2)", () => {
  test("US-005 AC2: a strategy without beforeDispatch calls callOp exactly once", async () => {
    const callOp = makeCallOpMock({ applied: true });
    const strategy = makeStrategy({ name: "autofix-test-writer" });

    const applied = await dispatchStrategy(strategy, makeCtx(), [lintA], [], dispatchDeps(callOp));

    expect(callOp).toHaveBeenCalledTimes(1);
    expect(applied).toMatchObject({ strategyName: "autofix-test-writer", op: "noop-op" });
  });

  test("US-005 AC2 boundary: the FixApplied accounting is unchanged when no hook is present", async () => {
    const callOp = makeCallOpMock({ applied: true });
    const strategy = makeStrategy({
      name: "autofix-test-writer",
      extractApplied: () => ({ targetFiles: ["test/a.test.ts"], summary: "edited" }),
    });

    const applied: FixApplied = await dispatchStrategy(strategy, makeCtx(), [lintA], [], dispatchDeps(callOp));

    // The whole record, not a subset: the hook must not perturb the dispatch's
    // existing spend/target/summary bookkeeping.
    expect(applied).toEqual({
      strategyName: "autofix-test-writer",
      op: "noop-op",
      targetFiles: ["test/a.test.ts"],
      summary: "edited",
      costUsd: 0,
    });
  });
});
