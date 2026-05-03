import { describe, expect, mock, test } from "bun:test";
import type { AgentRunOptions, SessionHandle, TurnResult } from "../../../src/agents/types";
import { createSessionRunHop } from "../../../src/runtime/session-run-hop";
import type { ISessionManager } from "../../../src/session";

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
    const sessionManager = {
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => handle),
      sendPrompt: mock(async () => turnResult),
      closeSession: mock(async () => {}),
    } as unknown as ISessionManager;

    const hop = createSessionRunHop(sessionManager);
    const result = await hop("claude", makeRunOptions());

    expect(result.result.protocolIds).toEqual({ recordId: "rec-hop", sessionId: "sess-hop" });
    expect(result.result.internalRoundTrips).toBe(2);
  });
});
