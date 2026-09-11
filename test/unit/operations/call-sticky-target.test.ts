/**
 * nax#1964: `runWithFallback` returned `finalAgent`/`finalTarget` and nothing read it, so
 * every op re-derived its dispatch agent from `ctx.agentName` — a story that swapped away
 * from a dead primary re-probed that dead primary on its very next op, and once the
 * per-story hop budget was spent it could no longer swap away again.
 *
 * These pin `callOp`'s fix: the target a story actually swapped to (via `runWithFallback`'s
 * `finalTarget`) is recorded on the run-scoped `runtime.ladderSlots` store, keyed by the
 * full escalation rung plus role (`ladderSlotKey(storyId, tier, agent, role)`), and a later
 * op of the same story, same rung, and same role dispatches straight to it instead of
 * re-resolving `ctx.agentName`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { CallContext, CompleteOperation, RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { SessionRole } from "@/session";

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
        didSwap: swapped,
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

/**
 * Reports a swap away from `deadAgent` on the complete() path: `completeAsWithFallback`
 * receives the agent callOp resolved to dispatch on (its first argument), so calling it
 * with `deadAgent` again — rather than the sticky target — is exactly the regression
 * this pins.
 */
function managerSwappingComplete(deadAgent: string, liveAgent: string, dispatched: string[]) {
  return makeMockAgentManager({
    completeAsWithFallbackFn: async (agentName) => {
      dispatched.push(agentName);
      const swapped = agentName === deadAgent;
      const fallbacks = swapped ? [hop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { output: "done", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agentName },
        didSwap: swapped,
        dispatchesCompleted: 1,
      };
    },
  });
}

/** Like `managerSwapping`, but also answers `completeAsWithFallback` (no swap on that path). */
function managerSwappingRunAndComplete(
  deadAgent: string,
  liveAgent: string,
  dispatchedRun: string[],
  dispatchedComplete: string[],
) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req, primaryAgentOverride) => {
      const agent = primaryAgentOverride ?? deadAgent;
      dispatchedRun.push(agent);
      const swapped = agent === deadAgent;
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(swapped ? liveAgent : agent, undefined, { kind: "primary" }, req.runOptions);
      const fallbacks = swapped ? [hop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agent },
        didSwap: swapped,
      };
    },
    completeAsWithFallbackFn: async (agentName) => {
      dispatchedComplete.push(agentName);
      return {
        result: { output: "done", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
        fallbacks: [],
        dispatchesCompleted: 1,
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

function makeCtx(opts: {
  runtime: NaxRuntime;
  storyId: string;
  agentName: string;
  sessionRole?: SessionRole;
}): CallContext {
  return {
    runtime: opts.runtime,
    packageView: opts.runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: opts.agentName,
    storyId: opts.storyId,
    ...(opts.sessionRole !== undefined ? { sessionOverride: { role: opts.sessionRole } } : {}),
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

  test("a later complete-kind op of the same story dispatches on the agent an earlier complete-kind op swapped to", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwappingComplete("native", "claude", dispatched) });
    createdRuntimes.push(runtime);
    const ctx = makeCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeCompleteOp("complete-op-one"), "work");
    await callOp(ctx, makeCompleteOp("complete-op-two"), "work");

    expect(dispatched).toEqual(["native", "claude"]);
  });

  test("a complete-kind op honours the target a run-kind op of the same story and role already swapped to", async () => {
    const dispatchedRun: string[] = [];
    const dispatchedComplete: string[] = [];
    const runtime = makeMockRuntime({
      agentManager: managerSwappingRunAndComplete("native", "claude", dispatchedRun, dispatchedComplete),
    });
    createdRuntimes.push(runtime);
    // A ladder slot is per (story, tier, agent, role) — makeOp() declares role "implementer",
    // so the complete-kind op must share that role via sessionOverride to see the same slot.
    const ctx = makeCtx({ runtime, storyId: "US-001", agentName: "native", sessionRole: "implementer" });

    await callOp(ctx, makeOp("run-op"), "work");
    await callOp(ctx, makeCompleteOp("complete-op"), "work");

    expect(dispatchedRun).toEqual(["native"]);
    expect(dispatchedComplete).toEqual(["claude"]);
  });

  test("a complete-kind op with no sessionOverride does NOT inherit another role's swap (#1965 D4)", async () => {
    const dispatchedRun: string[] = [];
    const dispatchedComplete: string[] = [];
    const runtime = makeMockRuntime({
      agentManager: managerSwappingRunAndComplete("native", "claude", dispatchedRun, dispatchedComplete),
    });
    createdRuntimes.push(runtime);
    // makeOp() declares role "implementer" and swaps native -> claude, recording a slot
    // keyed to that role. makeCompleteOp() carries no session role at all, and this ctx
    // sets no sessionOverride either, so its role resolves to undefined — a different key
    // from "implementer". It must dispatch its own configured agent, not the swapped one.
    const ctx = makeCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeOp("run-op"), "work");
    await callOp(ctx, makeCompleteOp("complete-op"), "work");

    expect(dispatchedRun).toEqual(["native"]);
    expect(dispatchedComplete).toEqual(["native"]);
  });
});
