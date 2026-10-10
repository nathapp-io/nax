/**
 * A1 caller 2 seam: FixCycle.onGiveUp lets a caller resolve an agent-gave-up
 * instead of exiting — after the #1654 remaining-claimant fall-through.
 */
import { describe, expect, test } from "bun:test";
import type { Finding, GiveUpInput, GiveUpResolution } from "@/findings";
import { createDeclineLedger, findingKey, runFixCycle } from "@/findings";
import { lintA, lintB, makeCallOpSpy, makeCtx, makeCycle, makeStrategy } from "./_cycle-fixtures";

/** Gives up on its first `giveUps` dispatches, then completes. */
function flaky(name: string, dispatched: string[], giveUps = 1) {
  let n = 0;
  return makeStrategy({
    name,
    coRun: "exclusive",
    maxAttempts: 3,
    extractApplied: () => {
      dispatched.push(name);
      n += 1;
      return { summary: "", ...(n <= giveUps ? { unresolved: "AC1 contradicts the finding" } : {}) };
    },
  });
}

describe("runFixCycle — onGiveUp hook (A1)", () => {
  test("a reinstated strategy is dispatched again and the cycle can resolve", async () => {
    const dispatched: string[] = [];
    const inputs: GiveUpInput<Finding>[] = [];
    let validations = 0;
    const cycle = makeCycle([lintA], [flaky("impl", dispatched)], async () => (++validations >= 1 ? [] : [lintA]), {
      onGiveUp: async (input) => {
        inputs.push(input);
        return { findings: [...input.findings], reinstate: ["impl"] };
      },
    });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(dispatched).toEqual(["impl", "impl"]);
    expect(r.exitReason).toBe("resolved");
    expect(inputs[0]?.gaveUp).toEqual([{ strategyName: "impl", unresolvedDetail: "AC1 contradicts the finding" }]);
    expect(inputs[0]?.attemptsLeft.impl).toBe(2);
  });

  test("an empty replacement set ends the cycle as resolved", async () => {
    const cycle = makeCycle([lintA], [flaky("impl", [], 9)], async () => [lintA], {
      onGiveUp: async () => ({ findings: [], reinstate: [] }),
    });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(r.exitReason).toBe("resolved");
  });

  test("null keeps today's agent-gave-up exit", async () => {
    const cycle = makeCycle([lintA], [flaky("impl", [], 9)], async () => [lintA], { onGiveUp: async () => null });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(r.exitReason).toBe("agent-gave-up");
    expect(r.unresolvedDetail).toBe("AC1 contradicts the finding");
  });

  test("an exit resolution appends the ruling to the give-up detail", async () => {
    const res: GiveUpResolution<Finding> = {
      findings: [lintA],
      reinstate: [],
      exit: { detailSuffix: "[advisor D-2: escalate]" },
    };
    const cycle = makeCycle([lintA], [flaky("impl", [], 9)], async () => [lintA], { onGiveUp: async () => res });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(r.exitReason).toBe("agent-gave-up");
    expect(r.unresolvedDetail).toBe("AC1 contradicts the finding [advisor D-2: escalate]");
  });

  test("a throwing hook behaves as null", async () => {
    const cycle = makeCycle([lintA], [flaky("impl", [], 9)], async () => [lintA], {
      onGiveUp: async () => {
        throw new Error("advisor exploded");
      },
    });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(r.exitReason).toBe("agent-gave-up");
  });

  test("with a remaining claimant the #1654 fall-through runs first and the hook is not called", async () => {
    const dispatched: string[] = [];
    let hookCalls = 0;
    const second = makeStrategy({
      name: "repo-scoped",
      coRun: "exclusive",
      maxAttempts: 1,
      extractApplied: () => {
        dispatched.push("repo-scoped");
        return { summary: "" };
      },
    });
    const cycle = makeCycle([lintA], [flaky("impl", dispatched, 9), second], async () => [], {
      onGiveUp: async () => {
        hookCalls += 1;
        return null;
      },
    });
    const r = await runFixCycle(cycle, makeCtx(), "c", { callOp: makeCallOpSpy().fn });
    expect(dispatched).toEqual(["impl", "repo-scoped"]);
    expect(hookCalls).toBe(0);
    expect(r.exitReason).toBe("resolved");
  });
});

describe("DeclineLedger.clearDeclined", () => {
  test("un-retires a strategy for exactly the given findings", () => {
    const ledger = createDeclineLedger<Finding>();
    const s = makeStrategy({ name: "impl" });
    ledger.recordDeclined(s, [lintA, lintB]);
    expect(ledger.isRetiredFor(s, [lintA])).toBe(true);
    ledger.clearDeclined("impl", [lintA]);
    expect(ledger.isRetiredFor(s, [lintA])).toBe(false);
    expect(ledger.isRetiredFor(s, [lintB])).toBe(true);
    expect(findingKey(lintA)).not.toBe(findingKey(lintB));
  });
});
