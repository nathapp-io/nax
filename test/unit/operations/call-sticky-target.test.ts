/**
 * nax#1964: `runWithFallback` returned `finalAgent`/`finalTarget` and nothing read it, so
 * every op re-derived its dispatch agent from `ctx.agentName` — a story that swapped away
 * from a dead primary re-probed that dead primary on its very next op, and once the
 * per-story hop budget was spent it could no longer swap away again.
 *
 * These pin `callOp`'s fix: the target a story actually swapped to (via `runWithFallback`'s
 * `finalTarget`) is recorded on the run-scoped `runtime.storyAgentTargets` store, keyed by
 * the full escalation rung (`storyFixKey(storyId, tier, agent)`), and a later op of the
 * same story at the same rung dispatches straight to it instead of re-resolving `ctx.agentName`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { CallContext, RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("sticky-target-test", "routing");
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

function makeOp(name: string, tier?: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    ...(tier !== undefined ? { model: tier } : {}),
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

/** Reports a swap away from `deadAgent`; dispatches straight through on any other agent. */
function managerSwapping(deadAgent: string, liveAgent: string, dispatched: string[]) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req, primaryAgentOverride) => {
      const agent = primaryAgentOverride ?? deadAgent;
      dispatched.push(agent);
      const swapped = agent === deadAgent;
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(swapped ? liveAgent : agent, undefined, { kind: "primary" }, req.runOptions);
      const fallbacks = swapped ? [hop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agent },
      };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

function makeCtx(opts: { runtime: NaxRuntime; storyId: string; agentName: string }): CallContext {
  return {
    runtime: opts.runtime,
    packageView: opts.runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: opts.agentName,
    storyId: opts.storyId,
  };
}

describe("callOp sticks a story to the agent it swapped to (#1964)", () => {
  test("a later op of the same story dispatches on the agent the earlier op swapped to", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);
    const ctx = makeCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeOp("op-one"), "work");
    await callOp(ctx, makeOp("op-two"), "work");

    expect(dispatched).toEqual(["native", "claude"]);
  });

  test("a different story is unaffected by another story's swap", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);

    await callOp(makeCtx({ runtime, storyId: "US-001", agentName: "native" }), makeOp("op-one"), "work");
    await callOp(makeCtx({ runtime, storyId: "US-002", agentName: "native" }), makeOp("op-two"), "work");

    expect(dispatched).toEqual(["native", "native"]);
  });

  test("an escalated tier gets a fresh agent choice", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);

    await callOp(makeCtx({ runtime, storyId: "US-001", agentName: "native" }), makeOp("op-one", "balanced"), "work");
    // Escalation bumped the story to powerful; the balanced rung's swap must not carry over.
    await callOp(makeCtx({ runtime, storyId: "US-001", agentName: "native" }), makeOp("op-two", "powerful"), "work");

    expect(dispatched).toEqual(["native", "native"]);
  });
});
