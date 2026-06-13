import { describe, expect, mock, test } from "bun:test";
import { makeSelfHealStep, runSelfHealChain } from "@/operations";
import type { HopBodyContext } from "@/operations/types";
import type { TurnResult } from "@/agents/types";

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
});
