import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TurnResult } from "@/agents/types";
import { makeSelfHealStep, runSelfHealChain } from "@/operations";
import type { HopBodyContext } from "@/operations/types";

function makeTurn(output: string, cost: number): TurnResult {
  return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
}

interface Input {
  readonly value: string;
}

function makeCtx(send: (p: string) => Promise<TurnResult>): HopBodyContext<Input> {
  return { input: { value: "x" }, send, sendWithParseRetry: send };
}

describe("runSelfHealChain", () => {
  test("returns the seed unchanged when there are no steps", async () => {
    const send = mock(async (_p: string) => makeTurn("unused", 9));
    const seed = makeTurn("seed-out", 3);
    const result = await runSelfHealChain(makeCtx(send), seed, []);
    expect(send).toHaveBeenCalledTimes(0);
    expect(result.output).toBe("seed-out");
    expect(result.estimatedCostUsd).toBe(3);
  });

  test("a healthy step (detect -> []) issues no turn and preserves the seed", async () => {
    const send = mock(async (_p: string) => makeTurn("repair", 5));
    const seed = makeTurn("seed-out", 2);
    const step = makeSelfHealStep<Input, string>({
      detect: async () => [],
      buildRepair: () => "should-not-be-sent",
    });
    const result = await runSelfHealChain(makeCtx(send), seed, [step]);
    expect(send).toHaveBeenCalledTimes(0);
    expect(result.output).toBe("seed-out");
    expect(result.estimatedCostUsd).toBe(2);
  });

  test("a deviating step sends one corrective turn, accumulates cost, returns that turn", async () => {
    const send = mock(async (_p: string) => makeTurn("repair-out", 4));
    const seed = makeTurn("seed-out", 1);
    const step = makeSelfHealStep<Input, string>({
      detect: async () => ["dev-a"],
      buildRepair: (deviations, input) => `fix ${deviations.join(",")} for ${input.value}`,
    });
    const result = await runSelfHealChain(makeCtx(send), seed, [step]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("fix dev-a for x");
    expect(result.output).toBe("repair-out");
    expect(result.estimatedCostUsd).toBe(5);
  });

  test("multiple steps: cost sums across deviating steps; last turn wins; healthy steps are skipped", async () => {
    let n = 0;
    const send = mock(async (_p: string) => {
      n += 1;
      return makeTurn(`repair-${n}`, n === 1 ? 4 : 6);
    });
    const seed = makeTurn("seed-out", 1);
    const deviating1 = makeSelfHealStep<Input, string>({
      detect: async () => ["a"],
      buildRepair: () => "fix-1",
    });
    const healthy = makeSelfHealStep<Input, string>({
      detect: async () => [],
      buildRepair: () => "never",
    });
    const deviating2 = makeSelfHealStep<Input, string>({
      detect: async () => ["b"],
      buildRepair: () => "fix-2",
    });
    const result = await runSelfHealChain(makeCtx(send), seed, [deviating1, healthy, deviating2]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "fix-1");
    expect(send).toHaveBeenNthCalledWith(2, "fix-2");
    expect(result.output).toBe("repair-2");
    expect(result.estimatedCostUsd).toBe(11); // 1 + 4 + 6
  });

  test("a throwing detector logs a warning and preserves the seed (throw isolation)", async () => {
    const send = mock(async (_p: string) => makeTurn("repair", 5));
    const seed = makeTurn("seed-out", 2);
    const throwing = makeSelfHealStep<Input, string>({
      detect: async () => {
        throw new Error("disk read failed");
      },
      buildRepair: () => "should-not-be-sent",
    });
    // Should not throw; seed must be preserved
    const result = await runSelfHealChain(makeCtx(send), seed, [throwing]);
    expect(send).toHaveBeenCalledTimes(0);
    expect(result.output).toBe("seed-out");
    expect(result.estimatedCostUsd).toBe(2);
  });
});

describe("makeSelfHealStep — log branch", () => {
  let infoSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const logger = initLogger({ level: "silent" });
    infoSpy = spyOn(logger, "info");
  });

  afterEach(async () => {
    infoSpy?.mockRestore();
    infoSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("emits logger.info once when deviations are present", async () => {
    const send = mock(async (_p: string) => makeTurn("repair", 1));
    const step = makeSelfHealStep<Input, string>({
      detect: async () => ["missing-ac"],
      buildRepair: () => "fix",
      log: {
        kind: "test-kind",
        message: "test message",
        meta: (_input, deviations) => ({ count: deviations.length }),
      },
    });
    await step.run(makeCtx(send));
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith("test-kind", "test message", { count: 1 });
  });

  test("does not call logger.info when there are no deviations (healthy)", async () => {
    const send = mock(async (_p: string) => makeTurn("repair", 1));
    const step = makeSelfHealStep<Input, string>({
      detect: async () => [],
      buildRepair: () => "fix",
      log: { kind: "test-kind", message: "test message" },
    });
    await step.run(makeCtx(send));
    expect(infoSpy).toHaveBeenCalledTimes(0);
  });
});
