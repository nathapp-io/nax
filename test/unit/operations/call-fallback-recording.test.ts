/**
 * nax#1707: callOp is the only place agent-swap hops surface, and it used to
 * discard them — `runWithFallback` returns `outcome.fallbacks`, callOp read only
 * `outcome.result`, and the reconstructed `ctx.agentResult` in post-run.ts carries
 * no fallback field. The hops therefore never reached StoryMetrics and
 * `RunMetrics.fallback.totalWastedCostUsd` was never computed.
 *
 * These pin the sink: callOp appends every recorded hop to the run-scoped
 * per-story `runtime.agentFallbacks` map, which collectStoryMetrics reads.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("fallback-recording-test", "routing");
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

/** A manager whose runWithFallback reports `fallbacks` alongside a successful result. */
function managerReporting(fallbacks: AgentFallbackRecord[]) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: fallbacks }, fallbacks };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

function makeOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function runtimeWith(fallbacks: AgentFallbackRecord[]): NaxRuntime {
  const runtime = makeMockRuntime({ agentManager: managerReporting(fallbacks) });
  createdRuntimes.push(runtime);
  return runtime;
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

describe("callOp records agent-swap hops on the run-scoped store (#1707)", () => {
  test("appends the hops runWithFallback reported, keyed by story", async () => {
    const recorded = [hop()];
    const runtime = runtimeWith(recorded);

    await callOp(ctxFor(runtime, "US-001"), makeOp("record-one"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toEqual(recorded);
  });

  test("accumulates hops across every op in the same story", async () => {
    const runtime = runtimeWith([hop({ hop: 1 })]);

    await callOp(ctxFor(runtime, "US-001"), makeOp("first-op"), "input");
    await callOp(ctxFor(runtime, "US-001"), makeOp("second-op"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(2);
  });

  test("keeps stories separate", async () => {
    const runtime = runtimeWith([hop()]);

    await callOp(ctxFor(runtime, "US-001"), makeOp("op-a"), "input");
    await callOp(ctxFor(runtime, "US-002"), makeOp("op-b"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(1);
    expect(runtime.agentFallbacks.get("US-002")).toHaveLength(1);
  });

  test("records nothing when the op ran with no swaps", async () => {
    const runtime = runtimeWith([]);

    await callOp(ctxFor(runtime, "US-001"), makeOp("no-swap"), "input");

    expect(runtime.agentFallbacks.has("US-001")).toBe(false);
  });

  test("drops hops from an ad-hoc call that carries no storyId", async () => {
    const runtime = runtimeWith([hop()]);

    await callOp(ctxFor(runtime), makeOp("no-story"), "input");

    expect(runtime.agentFallbacks.size).toBe(0);
  });
});
