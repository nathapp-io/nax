import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentRegistry } from "../../../src/agents/registry";
import { makeNaxConfig } from "../../helpers";

const availFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};

function makeConfig() {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

function makeRegistry(
  results: Record<string, { output: string; failure?: typeof availFailure }>,
) {
  return {
    getAgent: (name: string) => {
      const r = results[name];
      if (!r) return undefined;
      return {
        complete: mock(async () => ({
          output: r.output,
          costUsd: 0.01,
          source: "exact" as const,
          adapterFailure: r.failure,
        })),
      };
    },
  } as unknown as AgentRegistry;
}

describe("AgentManager.completeWithFallback (#567)", () => {
  test("returns output on success", async () => {
    const m = new AgentManager(makeConfig(), makeRegistry({ claude: { output: "hello" } }));
    const outcome = await m.completeWithFallback("prompt", { config: makeNaxConfig() } as never);
    expect(outcome.result.output).toBe("hello");
    expect(outcome.fallbacks).toHaveLength(0);
  });

  test("swaps to codex on auth failure", async () => {
    const registry = makeRegistry({
      claude: { output: "", failure: availFailure },
      codex: { output: "from codex" },
    });
    const m = new AgentManager(makeConfig(), registry);
    const outcome = await m.completeWithFallback("prompt", { config: makeNaxConfig() } as never);
    expect(outcome.result.output).toBe("from codex");
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
  });

  test("returns failure when no swap configured", async () => {
    const config = makeNaxConfig({
      agent: {
        fallback: {
          enabled: false,
          map: {},
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    });
    const m = new AgentManager(
      config,
      makeRegistry({ claude: { output: "", failure: availFailure } }),
    );
    const outcome = await m.completeWithFallback("prompt", { config: makeNaxConfig() } as never);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-auth");
  });
});
