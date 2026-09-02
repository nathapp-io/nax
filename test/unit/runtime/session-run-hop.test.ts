import { describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeSessionManager } from "@test/helpers";
import { SessionTurnError } from "@/agents";
import type { RunAsSessionOpts } from "@/agents/manager-types";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import type { ToolDescriptor } from "@/context/engine";
import { createSessionRunHop } from "@/runtime/session-run-hop";
import type { SendPromptOpts } from "@/session/types";

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
  // nax#1722: this path re-opens the same session name under the fallback agent on a
  // swap, and openSession leaves the descriptor's `agent` at the primary — so the hop
  // records the handoff itself.
  test("records a handoff when the session's descriptor names a different agent", async () => {
    const descriptor = {
      id: "sess-primary",
      role: "main" as const,
      state: "RUNNING" as const,
      agent: "claude",
      workdir: "/tmp/work",
      protocolIds: { recordId: null, sessionId: null },
      completedStages: [],
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
    };
    const handoff = mock(() => ({ ...descriptor, agent: "codex" }));
    const sessionManager = makeSessionManager({
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => ({ id: "nax-session", agentName: "codex" }) satisfies SessionHandle),
      descriptor: mock(() => descriptor),
      handoff,
      sendPrompt: mock(async () => ({
        output: "done",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
      closeSession: mock(async () => {}),
    });

    await createSessionRunHop(sessionManager)("codex", makeRunOptions());

    expect(handoff).toHaveBeenCalledWith("sess-primary", "codex", "agent-swap");
  });

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

  // Finding 3 (whole-branch review, 2026-09-02): both dispatch branches below
  // computed `hasContextTools` but never forwarded `contextPullTools` to the
  // transport — the three Phase B target ops route through
  // build-hop-callback.ts instead, so nothing broke today, but a future op on
  // the default hop would silently get an empty tool catalogue.
  const pullTools: ToolDescriptor[] = [
    {
      name: "query_neighbor",
      description: "d",
      inputSchema: { type: "object" },
      maxCallsPerSession: 5,
      maxTokensPerCall: 100,
    },
  ];

  test("forwards contextPullTools to sessionManager.sendPrompt (no-agentManager fallback branch)", async () => {
    const handle: SessionHandle = { id: "nax-session", agentName: "claude" };
    let capturedOpts: SendPromptOpts | undefined;
    const sessionManager = makeSessionManager({
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => handle),
      sendPrompt: mock(async (_handle: SessionHandle, _prompt: string, opts?: SendPromptOpts) => {
        capturedOpts = opts;
        return {
          output: "done",
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        } satisfies TurnResult;
      }),
      closeSession: mock(async () => {}),
    });

    const hop = createSessionRunHop(sessionManager);
    await hop("claude", { ...makeRunOptions(), contextPullTools: pullTools });

    expect(capturedOpts?.contextPullTools).toBe(pullTools);
  });

  test("forwards contextPullTools to agentManager.runAsSession (agentManager branch)", async () => {
    const handle: SessionHandle = { id: "nax-session", agentName: "claude" };
    let capturedOpts: RunAsSessionOpts | undefined;
    const sessionManager = makeSessionManager({
      nameFor: mock(() => "nax-session"),
      openSession: mock(async () => handle),
      closeSession: mock(async () => {}),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, _prompt, opts) => {
        capturedOpts = opts;
        return {
          output: "done",
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        } satisfies TurnResult;
      },
    });

    const hop = createSessionRunHop(sessionManager, () => agentManager);
    await hop("claude", { ...makeRunOptions(), contextPullTools: pullTools });

    expect(capturedOpts?.contextPullTools).toBe(pullTools);
  });
});
