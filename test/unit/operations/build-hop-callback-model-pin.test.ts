/**
 * Unit tests — buildHopCallback model resolution when a hop runs on an agent the
 * caller's pinned modelDef does not belong to (nax#1722).
 *
 * Found by the `fallback-probe` smoke run, not by the suite: `resolveStartAgent` starts
 * an operation on a fallback agent when the primary is already unavailable, and that hop
 * is still `{ kind: "primary" }`. The caller resolved `modelDef` for the PRIMARY, so
 * carrying it onto the substituted agent produced `acpx --model haiku ... codex`, which
 * the ACP agent rejects outright: "Cannot apply --model haiku: the ACP agent did not
 * advertise that model. Available models: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, …".
 *
 * `pinnedModelAgent` names the agent the pin was resolved for; any other agent
 * re-resolves from its own tier map.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeContextBundle, makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import { buildHopCallback } from "@/operations";
import type { BuildHopCallbackContext } from "@/operations/build-hop-callback";
import type { OpenSessionRequest } from "@/session/types";

const WORKDIR = "/tmp/nax-model-pin";
const SESSION_ID = "session-1";

const STUB_TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

const MODELS = {
  claude: { balanced: { provider: "anthropic", model: "haiku" } },
  codex: { balanced: { provider: "openai", model: "gpt-5.6-luna" } },
};

function harness(pinnedModelAgent?: string) {
  const config = makeNaxConfig({ models: MODELS });
  // Record the model the session was opened with rather than casting mock.calls back
  // into a shape — the adapter's own signature types it.
  const opened: string[] = [];
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string, opts: OpenSessionRequest) => {
      opened.push(opts.modelDef.model);
      return { id: name, agentName: opts.agentName } satisfies SessionHandle;
    }),
    closeSession: mock(async () => {}),
  });
  const ctx: BuildHopCallbackContext = {
    sessionManager,
    agentManager: makeMockAgentManager({ runAsSessionFn: mock(async () => STUB_TURN) }),
    story: makeStory({ id: "US-001" }),
    config,
    featureName: "fallback-probe",
    workdir: WORKDIR,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
    ...(pinnedModelAgent !== undefined && { pinnedModelAgent }),
  };
  const options: AgentRunOptions = {
    prompt: "do the work",
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "haiku" },
    timeoutSeconds: 30,
    config,
  };
  return { ctx, options, opened };
}

describe("buildHopCallback — pinned model vs dispatching agent", () => {
  test("a primary hop on another agent re-resolves the model from that agent's tier map", async () => {
    const { ctx, options, opened } = harness("claude");

    await buildHopCallback(ctx, SESSION_ID, options)("codex", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("gpt-5.6-luna");
  });

  test("the pin still applies on the agent it was resolved for", async () => {
    const { ctx, options, opened } = harness("claude");

    await buildHopCallback(ctx, SESSION_ID, options)("claude", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("haiku");
  });

  test("without pinnedModelAgent the pin is trusted (pre-nax#1722 behaviour for other callers)", async () => {
    const { ctx, options, opened } = harness();

    await buildHopCallback(ctx, SESSION_ID, options)("codex", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("haiku");
  });
});
