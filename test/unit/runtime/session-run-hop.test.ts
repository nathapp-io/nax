import { describe, expect, mock, test } from "bun:test";
import { SessionTurnError } from "@/agents";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import { createSessionRunHop } from "@/runtime/session-run-hop";
import { makeSessionManager } from "@test/helpers";

function makeRunOptions(): AgentRunOptions {
  return {
    prompt: "do the work",
    workdir: "/tmp/work",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: {},
    pipelineStage: "run",
    sessionRole: "implementer",
    featureName: "feat",
    storyId: "US-001",
  } as AgentRunOptions;
}

describe("createSessionRunHop", () => {
  test("preserves handle protocolIds and internalRoundTrips in AgentResult", async () => {
    const handle: SessionHandle = {
      id: "nax-session",
      agentName: "claude",
      protocolIds: { recordId: "rec-hop", sessionId: "sess-hop" },
    };
    const turnResult: TurnResult = {
      output: "done",
      tokenUsage: { inputTokens: 1, outputTokens: 2 },
      estimatedCostUsd: 0.003,
      internalRoundTrips: 2,
    };
    const sessionManager = makeSessionManager({
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => handle),
      sendPrompt: mock(async () => turnResult),
      closeSession: mock(async () => {}),
    });

    const hop = createSessionRunHop(sessionManager);
    const result = await hop("claude", makeRunOptions());

    expect(result.result.protocolIds).toEqual({ recordId: "rec-hop", sessionId: "sess-hop" });
    expect(result.result.internalRoundTrips).toBe(2);
  });

  // BUG-57: a SessionTurnError (e.g. a mid-flight cancel) carries whatever
  // tokenUsage/cost the adapter already accumulated before failing — the
  // failure AgentResult must surface it instead of hardcoding
  // estimatedCostUsd: 0, mirroring the same fix in build-hop-callback.ts.
  test("SessionTurnError's carried tokenUsage/cost flow through to the failure AgentResult", async () => {
    const handle: SessionHandle = { id: "nax-session", agentName: "claude" };
    const turnError = new SessionTurnError(
      "Agent session ended with stop reason: error (externally cancelled)",
      true,
      false,
      { inputTokens: 250, outputTokens: 90 },
      0.0055,
      0.0049,
    );
    const sessionManager = makeSessionManager({
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => handle),
      sendPrompt: mock(async () => {
        throw turnError;
      }),
      closeSession: mock(async () => {}),
    });

    const hop = createSessionRunHop(sessionManager);
    const result = await hop("claude", makeRunOptions());

    expect(result.result.success).toBe(false);
    expect(result.result.estimatedCostUsd).toBe(0.0055);
    expect(result.result.exactCostUsd).toBe(0.0049);
    expect(result.result.tokenUsage?.inputTokens).toBe(250);
    expect(result.result.tokenUsage?.outputTokens).toBe(90);
  });
});
