/**
 * runThreeSessionTdd — totalTokenUsage + totalDurationMs aggregation (#590).
 *
 * Each TDD session reports its own tokenUsage/durationMs; the orchestrator
 * now sums them so the metrics tracker can emit a tokens block for TDD runs
 * the same way it does for single-session runs.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import { makeNaxConfig, makeMockRuntime } from "../../helpers";
import { fakeAgentManager } from "../../helpers/fake-agent-manager";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
    attempts: 0,
    priorFailures: [],
  } as unknown as UserStory;
}

function makeConfig() {
  return makeNaxConfig({
    models: {
      claude: {
        fast: "fast",
        balanced: "balanced",
        powerful: "powerful",
      },
    },
    agent: { default: "claude" },
    execution: { rectification: { enabled: false }, sessionTimeoutSeconds: 300 },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [], rollbackOnFailure: false },
  });
}

/**
 * Build an agent adapter whose sendTurn returns specific tokenUsage per sequential call.
 * Output is JSON-encoded so that when ops' parse() is updated (AC6 implementation),
 * parse produces success:true and filesChanged for the test-writer session — passing
 * the greenfield guard in the orchestrator.
 */
function agentReturning(tokens: Array<AgentResult["tokenUsage"] | undefined>) {
  let call = 0;
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as ("fast" | "balanced" | "powerful")[],
      maxContextTokens: 200_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(),
    },
    isInstalled: mock(async () => true),
    buildCommand: mock(() => [] as string[]),
    complete: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 })),
    plan: mock(async () => ({ specContent: "" })),
    decompose: mock(async () => ({ stories: [] })),
    closePhysicalSession: mock(async () => {}),
    openSession: mock(async () => ({ id: "mock-session", agentName: "mock" })),
    sendTurn: mock(async () => {
      const tokenUsage = tokens[call];
      // First call is always the test-writer session; include a test file so the
      // orchestrator's greenfield guard is satisfied once parse() returns filesChanged.
      const filesChanged = call === 0 ? ["test/foo.test.ts"] : [];
      call++;
      return {
        output: JSON.stringify({ success: true, filesChanged }),
        tokenUsage,
        internalRoundTrips: 1,
        estimatedCostUsd: 0.01,
      };
    }),
    closeSession: mock(async () => {}),
  };
}

describe("runThreeSessionTdd — token + duration aggregation", () => {
  test("sums tokenUsage from all three sessions", async () => {
    const agent = agentReturning([
      { inputTokens: 100, outputTokens: 50 }, // test-writer
      { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 10 }, // implementer
      { inputTokens: 50, outputTokens: 25 }, // verifier
    ]);
    const agentManager = fakeAgentManager(agent as never);
    const runtime = makeMockRuntime({ agentManager, config: makeConfig() });

    const result = await runThreeSessionTdd({
      agent: agent as never,
      agentManager,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
      runtime,
    });

    expect(result.totalTokenUsage).toEqual({
      inputTokens: 350,
      outputTokens: 175,
      cacheReadInputTokens: 10,
    });
  });

  test("totalTokenUsage undefined when no session reports usage", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);
    const agentManager = fakeAgentManager(agent as never);
    const runtime = makeMockRuntime({ agentManager, config: makeConfig() });

    const result = await runThreeSessionTdd({
      agent: agent as never,
      agentManager,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
      runtime,
    });

    expect(result.totalTokenUsage).toBeUndefined();
  });

  test("totalDurationMs sums session durations", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);
    const agentManager = fakeAgentManager(agent as never);
    const runtime = makeMockRuntime({ agentManager, config: makeConfig() });

    const result = await runThreeSessionTdd({
      agent: agent as never,
      agentManager,
      story: makeStory(),
      config: makeConfig(),
      workdir: "/tmp/fake",
      modelTier: "balanced",
      runtime,
    });

    // Each session is timed by the orchestrator (startTime → Date.now()),
    // so the exact value is non-deterministic, but must be a sum ≥ 0.
    expect(typeof result.totalDurationMs).toBe("number");
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
