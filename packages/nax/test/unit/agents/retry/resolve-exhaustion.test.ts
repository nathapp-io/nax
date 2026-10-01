import { describe, expect, test } from "bun:test";
import { resolveExhaustion } from "@/agents/retry/resolve-exhaustion";
import type { RetryContext, RetryStrategy } from "@/agents/retry/types";
import type { AdapterFailure } from "@/context/engine";

const failure = (outcome: AdapterFailure["outcome"], retryAfterSeconds?: number): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

const retryCtx: RetryContext = { site: "run", agentName: "claude", stage: "run", storyId: "us-001" };

const alwaysRetry: RetryStrategy = { shouldRetry: () => ({ retry: true, delayMs: 45_000 }) };
const neverRetry: RetryStrategy = { shouldRetry: () => ({ retry: false }) };

function harness(overrides: Partial<Parameters<typeof resolveExhaustion>[0]> = {}) {
  const slept: number[] = [];
  const exhausted: number[] = [];
  const input = {
    failure: failure("fail-rate-limit"),
    attempt: 0,
    hopsSoFar: 0,
    swapWasPossible: true,
    retryStrategy: alwaysRetry,
    retryCtx,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    onExhausted: (hops: number) => {
      exhausted.push(hops);
    },
    ...overrides,
  };
  return { input, slept, exhausted };
}

describe("resolveExhaustion", () => {
  test("backs off for the granted delay and reports retry", async () => {
    const { input, slept, exhausted } = harness();
    expect(await resolveExhaustion(input)).toBe("retry");
    expect(slept).toEqual([45_000]);
    expect(exhausted).toEqual([]);
  });

  test("does not consult the strategy when the policy sets terminalBackoff false", async () => {
    let consulted = false;
    const spy: RetryStrategy = {
      shouldRetry: () => {
        consulted = true;
        return { retry: true, delayMs: 1 };
      },
    };
    const { input, slept } = harness({ failure: failure("fail-quality"), retryStrategy: spy });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(consulted).toBe(false);
    expect(slept).toEqual([]);
  });

  test("with no failure it neither backs off nor emits", async () => {
    const { input, slept, exhausted } = harness({ failure: undefined, swapWasPossible: false });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(slept).toEqual([]);
    expect(exhausted).toEqual([]);
  });

  test("an aborted signal cancels without emitting", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, exhausted } = harness({ signal: controller.signal });
    expect(await resolveExhaustion(input)).toBe("cancelled");
    expect(exhausted).toEqual([]);
  });

  test("emits onExhausted with the hop count when a swap was possible", async () => {
    const { input, exhausted } = harness({ retryStrategy: neverRetry, hopsSoFar: 2 });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([2]);
  });

  test("emits at hops 0 — the cliff that previously reported nothing", async () => {
    const { input, exhausted } = harness({ retryStrategy: neverRetry, hopsSoFar: 0 });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([0]);
  });

  test("a policy decline does not back off and does not emit — it is not exhaustion", async () => {
    const { input, slept, exhausted } = harness({ retryStrategy: neverRetry, swapWasPossible: false });
    expect(await resolveExhaustion(input)).toBe("exhausted");
    expect(exhausted).toEqual([]);
    expect(slept).toEqual([]);
  });
});
