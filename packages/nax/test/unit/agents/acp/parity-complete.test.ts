// test/unit/agents/acp/parity-complete.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { hangTurn, replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpDeps, AcpAgentAdapter } from "@/agents/acp";
import { FALLBACK_RATES } from "@/agents/cost";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL = { ..._acpDeps };
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-parity-complete-");
  _acpDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpDeps.cwdExists = async () => true;
});

afterEach(() => {
  Object.assign(_acpDeps, REAL);
  cleanupTempDir(dir);
});

function options(overrides: Partial<ResolvedCompleteOptions> = {}): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "sonnet" },
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    ...overrides,
  };
}

function scripted(...turns: Parameters<typeof scriptedOpened>[0]) {
  const script = scriptedOpened(turns);
  _acpDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
  return script;
}

describe("complete() pricing parity with acpx (adapter-rate-card-pricing, adapter-complete-rates)", () => {
  test("pricingSource and rates come from the resolved card", async () => {
    _acpDeps.resolveRateCard = async () => ({
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      source: "catalog-rates",
    });
    scripted(replyTurn("x", { inputTokens: 1_000_000, outputTokens: 0, costUsd: 0 }));
    const result = await new AcpAgentAdapter("claude").complete("q", options());
    expect(result.pricingSource).toBe("catalog-rates");
    expect(result.estimatedCostUsd).toBeCloseTo(3);
    expect(result.rates).toMatchObject({ input: 3, output: 15 });
  });

  test("zero tokens: cost 0 and no rates (AC7 boundary)", async () => {
    scripted(replyTurn("x", { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    const result = await new AcpAgentAdapter("claude").complete("q", options());
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.rates).toBeUndefined();
  });

  test("the reported cost is exactCostUsd and never replaces the card estimate (AC7)", async () => {
    scripted(replyTurn("x", { inputTokens: 10, outputTokens: 10, costUsd: 9.99 }));
    const result = await new AcpAgentAdapter("claude").complete("q", options());
    expect(result.exactCostUsd).toBeCloseTo(9.99);
    expect(result.estimatedCostUsd).not.toBeCloseTo(9.99);
  });

  test("a cancelled-but-billable result carries the card source (degraded results)", async () => {
    scripted(hangTurn({ inputTokens: 5, outputTokens: 5, costUsd: 0.01 }));
    const cancels: Array<() => Promise<void>> = [];
    const pending = new AcpAgentAdapter("claude").complete(
      "q",
      options({ onActiveCall: (_id, cancel) => cancels.push(cancel) }),
    );
    await waitForCondition(() => cancels.length > 0);
    await cancels[0]?.();
    expect(await pending).toMatchObject({ cancelled: true, pricingSource: "fallback-rates" });
  });
});
