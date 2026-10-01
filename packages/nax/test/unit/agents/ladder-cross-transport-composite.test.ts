/**
 * nax#1965 final-review fix, cross-transport half: `ladder-across-ops.test.ts`
 * proves `native <-> claude` close/reopen is correct GIVEN a hand-supplied
 * model sequence via direct `SessionManager.openSession` calls — it never
 * calls `callOp`, never exercises the real `AgentManager.nextCandidate` /
 * depth resolution, and never goes through the slot path. It does not prove
 * anything CHOSE to cross transports, only that the session layer behaves
 * once told to.
 *
 * This file is the cross-transport sibling of `ladder-across-ops-composite.test.ts`
 * (which drives the all-native A -> B -> C ladder through the real stack). It
 * drives BOTH cross-transport directions the same way:
 *
 *  - `AgentManager` (real): `nextCandidate`, depth resolution, `CooldownStore`.
 *  - The configured `agent.fallback.map` ladder (real), with `agent.protocol`
 *    set to `"hybrid"` — a ladder mixing `native` with an acpx agent requires
 *    it, and this branch added config-load validation that rejects the mix
 *    otherwise.
 *  - `SessionManager` (real, via `createRuntime`'s default): `decideReuse`.
 *  - The slot read/write path (real): `resolveDispatchTarget` / `recordDispatchOutcome`,
 *    exercised by `callOp` itself.
 *
 * The ONLY stub is the adapter's underlying dispatch (`openSession` / `sendTurn`
 * / `closeSession`) — registered via `_registryTestAdapters`, the same pattern
 * `ladder-across-ops-composite.test.ts` uses.
 *
 * The assertion that matters most: before this branch, a cross-agent swap
 * overwrote `SessionManager`'s `_liveHandles` entry without calling
 * `closeSession`, orphaning the `acpx` subprocess on a `claude -> native`
 * swap specifically (the reverse direction leaks nothing, because the native
 * adapter has no process — exactly why the field run never surfaced it). Both
 * directions below assert `closeSession` was invoked with the PRIOR handle,
 * and which agent that handle belonged to.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import { _registryTestAdapters } from "@/agents/registry";
import type { OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { callOp } from "@/operations/call";
import type { RunOperation } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

const STORY_ID = "US-1";
const FEATURE_NAME = "ladder-cross-transport";

const MODELS = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
  claude: { balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
} as const;

/**
 * A ladder that crosses transports in both directions: native's primary rung
 * falls to claude, and claude's primary rung falls to native. Both rungs are
 * spelled with an explicit tier so the dispatched model is unambiguous and
 * distinct per agent (`MODELS.claude.balanced` !== `MODELS.native.balanced`).
 *
 * `protocol: "hybrid"` is required — a ladder that mixes `native` with an
 * acpx agent (`claude`) is rejected at config-load otherwise.
 */
function crossTransportLadderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [{ agent: "claude", model: "balanced" }],
          claude: [{ agent: "native", model: "balanced" }],
        },
        maxHopsPerStory: 3,
      },
    },
    models: MODELS,
  });
}

function rateLimitFailure(): AdapterFailure {
  return { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "429" };
}

interface Dispatched {
  readonly agent: string;
  readonly model: string;
}

/**
 * Stubs ONLY the adapter's dispatch primitives, shared across both registered
 * agent names (mirrors `ladder-across-ops.test.ts`'s `recordingAdapter()`).
 * `openSession` stamps the handle with the model it was actually asked to
 * open; `sendTurn` fails the first hop and succeeds the second, recording the
 * endpoint (agent + model) read off the live handle each time; `closeSession`
 * records the handle it was asked to close, so a dropped-handle regression
 * (overwrite instead of close) shows up as an empty `closed` array.
 */
function scriptedAdapter() {
  const dispatched: Dispatched[] = [];
  const closed: SessionHandle[] = [];
  const script: ReadonlyArray<"fail" | "ok"> = ["fail", "ok"];
  let turn = 0;
  const adapter = makeAgentAdapter({
    openSession: async (name: string, opts: OpenSessionOpts): Promise<SessionHandle> => ({
      id: name,
      agentName: opts.agentName,
      modelDef: opts.modelDef,
    }),
    sendTurn: async (handle: SessionHandle): Promise<TurnResult> => {
      dispatched.push({ agent: handle.agentName, model: handle.modelDef?.model ?? "unknown" });
      const outcome = script[turn] ?? "ok";
      turn += 1;
      if (outcome === "fail") {
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          adapterFailure: rateLimitFailure(),
        };
      }
      return {
        output: "done",
        tokenUsage: { inputTokens: 5, outputTokens: 5 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      };
    },
    closeSession: async (handle: SessionHandle): Promise<void> => {
      closed.push(handle);
    },
  });
  return { adapter, dispatched, closed };
}

const sel = pickSelector("ladder-cross-transport-test", "routing");

function makeRunOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: sel,
    session: { role: "implementer", lifetime: "warm" },
    build: (input) => ({
      role: { id: "role", content: "You are an implementer.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
  _registryTestAdapters.delete("native");
  _registryTestAdapters.delete("claude");
});

describe("a story's ladder crossing agent transports, decided by the real stack (nax#1965)", () => {
  test("native -> claude: the real nextCandidate descends to claude's OWN model, and the native handle is closed", async () => {
    const config = crossTransportLadderConfig();
    expect(config.agent?.protocol).toBe("hybrid");

    const { adapter, dispatched, closed } = scriptedAdapter();
    _registryTestAdapters.set("native", adapter);
    _registryTestAdapters.set("claude", adapter);

    const realAgentManager = new AgentManager(config, undefined, { models: config.models });
    const runtime = makeTestRuntime({ config, agentManager: realAgentManager, featureName: FEATURE_NAME });
    createdRuntimes.push(runtime);

    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/test",
      agentName: "native",
      storyId: STORY_ID,
      featureName: FEATURE_NAME,
    };

    await callOp(ctx, makeRunOp("implementer"), "implement the story");

    // native (fail, native's own model) -> claude (ok, claude's own model —
    // NOT native's model reused across the swap).
    expect(dispatched).toEqual([
      { agent: "native", model: MODELS.native.balanced },
      { agent: "claude", model: MODELS.claude.balanced },
    ]);
    expect(dispatched.at(-1)?.model).not.toBe(MODELS.native.balanced);

    // The prior (native) handle was closed, not silently overwritten.
    expect(closed).toHaveLength(1);
    expect(closed[0]?.agentName).toBe("native");
    expect(closed[0]?.modelDef?.model).toBe(MODELS.native.balanced);

    const slot = runtime.ladderSlots.get("US-1::balanced::native::implementer");
    expect(slot?.target).toEqual({ agent: "claude", tier: "balanced" });
    expect(slot?.depth).toBe(1);
  });

  test("claude -> native: the real nextCandidate descends to native's OWN model, and the acpx (claude) handle is closed rather than orphaned", async () => {
    const config = crossTransportLadderConfig();
    expect(config.agent?.protocol).toBe("hybrid");

    const { adapter, dispatched, closed } = scriptedAdapter();
    _registryTestAdapters.set("native", adapter);
    _registryTestAdapters.set("claude", adapter);

    const realAgentManager = new AgentManager(config, undefined, { models: config.models });
    const runtime = makeTestRuntime({ config, agentManager: realAgentManager, featureName: FEATURE_NAME });
    createdRuntimes.push(runtime);

    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/test",
      agentName: "claude",
      storyId: STORY_ID,
      featureName: FEATURE_NAME,
    };

    await callOp(ctx, makeRunOp("implementer"), "implement the story");

    // claude (fail, claude's own model) -> native (ok, native's own model —
    // NOT claude's model reused across the swap).
    expect(dispatched).toEqual([
      { agent: "claude", model: MODELS.claude.balanced },
      { agent: "native", model: MODELS.native.balanced },
    ]);
    expect(dispatched.at(-1)?.model).not.toBe(MODELS.claude.balanced);

    // The prior (claude/acpx) handle was closed — this is the direction that
    // orphans a real acpx subprocess if the swap silently overwrites instead.
    expect(closed).toHaveLength(1);
    expect(closed[0]?.agentName).toBe("claude");
    expect(closed[0]?.modelDef?.model).toBe(MODELS.claude.balanced);

    const slot = runtime.ladderSlots.get("US-1::balanced::claude::implementer");
    expect(slot?.target).toEqual({ agent: "native", tier: "balanced" });
    expect(slot?.depth).toBe(1);
  });
});
