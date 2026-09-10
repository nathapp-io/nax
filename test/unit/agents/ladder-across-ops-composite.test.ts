/**
 * nax#1965 final-review fix: the existing `ladder-across-ops.test.ts` proves
 * `SessionManager.decideReuse` is correct GIVEN a hand-supplied model
 * sequence — it never calls `AgentManager.runWithFallback`, never exercises
 * `nextCandidate` / depth resolution, and never goes through `callOp`'s
 * `resolveDispatchTarget` / `recordDispatchOutcome` slot path. It does not
 * prove anything CHOSE that sequence.
 *
 * This file drives the same "native A -> native B -> native C across two
 * operations of one story" scenario through `callOp`, so every decision is
 * made by the real stack:
 *
 *  - `AgentManager` (real): `nextCandidate`, depth resolution, `CooldownStore`.
 *  - The configured `agent.fallback.map` ladder (real): `resolveFallbackDispatchTarget`
 *    / `resolveFallbackModelId`, exercised internally by `AgentManager`.
 *  - `SessionManager` (real, via `createRuntime`'s default): `decideReuse`.
 *  - The slot read/write path (real): `resolveDispatchTarget` / `recordDispatchOutcome`
 *    / `ladderSlotFor` / `recordLadderSlot`, exercised by `callOp` itself.
 *
 * The ONLY stub is the adapter's underlying dispatch (`openSession` /
 * `sendTurn`) — the point where a real model string would hit a real
 * provider. It is scripted: rate-limit on native A, rate-limit on native B,
 * success on native C — and it records which agent/model it was actually
 * asked to dispatch, the same way `ladder-across-ops.test.ts`'s
 * `recordingAdapter()` does.
 *
 * Seam driven: `callOp` (kind:"run"), which is what production dispatches
 * through — NOT a hand-built `runWithFallback` request. This exercises
 * `resolveDispatchTarget` / `recordDispatchOutcome` exactly as a real pipeline
 * stage would.
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
const FEATURE_NAME = "ladder-composite";

const MODELS = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
  claude: { balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
} as const;

/** The literal pin standing in for "native C" — a rung the ladder map spells
 * as a literal model id, not a tier, mirroring the existing test's rung 2. */
const NATIVE_C_MODEL = "openrouter/z-ai/glm-5.3-flash[high]";

function ladderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [{ agent: "native", model: "powerful" }, { agent: "native", model: NATIVE_C_MODEL }, "claude"],
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

/**
 * Stubs ONLY the adapter's dispatch. `openSession` stamps the handle with the
 * model it was actually asked to open (mirroring the real adapter), and
 * `sendTurn` plays back a scripted outcome sequence keyed on call order —
 * fail, ok, fail, ok — recording the endpoint (agent + model, read off the
 * live handle) each time it is invoked. Reading the model off the handle
 * (rather than off the request) is deliberate: a warm-session reuse dispatches
 * a turn with NO new `openSession` call, so the handle is the only place the
 * endpoint identity is observable for that hop.
 */
function scriptedAdapter() {
  const dispatched: Array<{ agent: string; model: string }> = [];
  const script: ReadonlyArray<"fail" | "ok"> = ["fail", "ok", "fail", "ok"];
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
  });
  return { adapter, dispatched };
}

const sel = pickSelector("ladder-composite-test", "routing");

function makeRunOp(
  name: string,
  stage: "run" | "rectification",
): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage,
    config: sel,
    // Warm: the session must stay live across hops within an op AND across
    // ops of the same story/role, or SessionManager.decideReuse (the thing
    // under test) never gets a live handle to reuse in the first place.
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

describe("a story's ladder across two callOp-dispatched operations (nax#1965 real fix-wave)", () => {
  test("native A -> native B -> native C, decided by the real stack, not by the test", async () => {
    const { adapter, dispatched } = scriptedAdapter();
    // Only the adapter primitive is stubbed — registered as the ADAPTER the
    // real AgentRegistry hands back for "native" (and "claude", so a wrongly
    // chosen candidate is dispatchable rather than throwing AGENT_NOT_FOUND,
    // which would hide a real defect behind a registry error).
    _registryTestAdapters.set("native", adapter);
    _registryTestAdapters.set("claude", adapter);

    const config = ladderConfig();
    // `models` must be injected explicitly — `AgentManagerConfig` deliberately
    // excludes it (ADR-019), and `configureRuntime` (called by `createRuntime`
    // below) does not backfill `_models` after construction. Without this, a
    // fallback target spelled `{ agent, model: "powerful" }` never resolves
    // through `resolveFallbackDispatchTarget` and dispatches "powerful" as a
    // literal model id instead of the configured tier.
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

    // Op 1: primary (native A) fails; the REAL nextCandidate picks native B, and
    // op 1 succeeds there.
    await callOp(ctx, makeRunOp("implementer", "run"), "implement the story");

    expect(dispatched).toEqual([
      { agent: "native", model: MODELS.native.balanced },
      { agent: "native", model: MODELS.native.powerful },
    ]);

    // The slot callOp wrote after op 1 holds native B.
    const slot = runtime.ladderSlots.get("US-1::balanced::native::implementer");
    expect(slot?.target).toEqual({ agent: "native", tier: "powerful" });
    expect(slot?.depth).toBe(1);

    // Op 2: a DIFFERENT op (rectification stage) of the SAME story/role. It
    // must dispatch native B because it read the slot op 1 wrote — this test
    // supplies no modelDef for it at all.
    await callOp(ctx, makeRunOp("autofix-implementer", "rectification"), "fix the failure");

    // Four hops total: op 1's A (fail) and B (ok); op 2's B (fail, reused
    // handle — no new openSession, but sendTurn still dispatches against it)
    // and C (ok, the real depth-aware nextCandidate's pick).
    expect(dispatched).toEqual([
      { agent: "native", model: MODELS.native.balanced },
      { agent: "native", model: MODELS.native.powerful },
      { agent: "native", model: MODELS.native.powerful },
      { agent: "native", model: NATIVE_C_MODEL },
    ]);

    // Op 2's final dispatch is native C — specifically not claude, and not a
    // return to native A.
    const finalDispatch = dispatched.at(-1);
    expect(finalDispatch?.agent).toBe("native");
    expect(finalDispatch?.model).toBe(NATIVE_C_MODEL);
    expect(finalDispatch?.model).not.toBe(MODELS.claude.balanced);
    expect(finalDispatch?.model).not.toBe(MODELS.native.balanced);

    // The slot now reflects op 2's landing rung.
    const slotAfterOp2 = runtime.ladderSlots.get("US-1::balanced::native::implementer");
    expect(slotAfterOp2?.target).toEqual({ agent: "native", model: NATIVE_C_MODEL });
    expect(slotAfterOp2?.depth).toBe(2);
  });
});
