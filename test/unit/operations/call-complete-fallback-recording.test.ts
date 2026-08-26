/**
 * nax#1712: the complete()-path twin of the #1707 sink in
 * call-fallback-recording.test.ts.
 *
 * `completeWithFallback` built a correct AgentFallbackRecord[], but `completeAs`
 * returned `outcome.result` and dropped it, so a swap taken on the complete() path
 * never reached `runtime.agentFallbacks` and was invisible to StoryMetrics.fallback.
 * callOp's complete branch now reads the outcome and feeds the same sink the run
 * branch uses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { CompleteOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("complete-fallback-recording-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function hop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
  return {
    storyId: "US-001",
    priorAgent: "claude",
    newAgent: "codex",
    hop: 1,
    outcome: "fail-quota",
    category: "availability",
    timestamp: "2026-08-25T00:00:00.000Z",
    costUsd: 0.25,
    ...overrides,
  };
}

/** A manager whose completeAsWithFallback reports `fallbacks` beside a good result. */
function runtimeWith(fallbacks: AgentFallbackRecord[]): NaxRuntime {
  const agentManager = makeMockAgentManager({
    completeAsWithFallbackFn: async () => ({
      result: {
        output: "complete-out",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      },
      fallbacks,
    }),
  });
  const runtime = makeMockRuntime({ agentManager });
  createdRuntimes.push(runtime);
  return runtime;
}

function makeCompleteOp(name: string): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name,
    stage: "complete",
    config: testSel,
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function ctxFor(runtime: NaxRuntime, storyId?: string) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    ...(storyId !== undefined ? { storyId } : {}),
  };
}

describe("callOp records complete()-path agent-swap hops (#1712)", () => {
  test("AC-3: appends the hops completeAsWithFallback reported, keyed by story", async () => {
    const recorded = [hop()];
    const runtime = runtimeWith(recorded);

    await callOp(ctxFor(runtime, "US-001"), makeCompleteOp("record-one"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toEqual(recorded);
  });

  test("AC-4: a second writer accumulates rather than replacing", async () => {
    const runtime = runtimeWith([hop({ hop: 1 })]);

    await callOp(ctxFor(runtime, "US-001"), makeCompleteOp("first-op"), "input");
    await callOp(ctxFor(runtime, "US-001"), makeCompleteOp("second-op"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(2);
  });

  test("AC-5: an ad-hoc call carrying no storyId records nothing", async () => {
    const runtime = runtimeWith([hop()]);

    await callOp(ctxFor(runtime), makeCompleteOp("no-story"), "input");

    expect(runtime.agentFallbacks.size).toBe(0);
  });
});
