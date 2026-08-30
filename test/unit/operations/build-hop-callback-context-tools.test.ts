/**
 * nax#1744 — a context pull tool must actually reach the agent on the run() path.
 *
 * `callOp` dispatches through `buildHopCallback` as `request.executeHop`
 * (call.ts), and `AgentManager.runWithFallback` invokes `executeHop` INSTEAD OF
 * `_runHop` — so `createSessionRunHop` (runtime/session-run-hop.ts), which is
 * where the pull-tool preamble, the interaction handler and the raised turn
 * budget used to live exclusively, is bypassed entirely on that path.
 *
 * The bundle, the descriptors and the tool runtime were all assembled correctly
 * by #1737/#1741/#1742; the agent was simply never told the tools existed. Each
 * seam passed its own unit test while the chain was dead end to end, which is
 * why these assertions are on what reaches `runAsSession`, not on any seam.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeContextBundle,
  makeContextManifest,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
} from "@test/helpers";
import type { AgentRunOptions, HopKind, RunAsSessionOpts, SessionHandle, TurnResult } from "@/agents";
import type { ContextBundle, ToolDescriptor } from "@/context/engine";
import type { BuildHopCallbackContext } from "@/operations";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";

const WORKDIR = "/repo";
const SESSION_ID = "sess-1744";

const QUERY_NEIGHBOR: ToolDescriptor = {
  name: "query_neighbor",
  description: "Look up import-graph neighbours of a file",
  inputSchema: { type: "object", properties: {} },
  maxCallsPerSession: 5,
  maxTokensPerCall: 2000,
};

function makeBundle(pullTools: ToolDescriptor[]): ContextBundle {
  return makeContextBundle({
    pullTools,
    pushMarkdown: "## Context",
    manifest: makeContextManifest({ requestId: "req-1744" }),
  });
}

/** What the agent was actually dispatched — the only seam that proves reachability. */
interface Dispatch {
  prompt: string;
  opts: RunAsSessionOpts;
}

function makeCtx(dispatch: Dispatch[], overrides: Partial<BuildHopCallbackContext> = {}): BuildHopCallbackContext {
  const handle: SessionHandle = { id: "nax-1744", agentName: "claude" };
  return {
    sessionManager: makeSessionManager({ openSession: mock(async () => handle) }),
    agentManager: makeMockAgentManager({
      runAsSessionFn: (_agentName, _handle, prompt, opts): Promise<TurnResult> => {
        dispatch.push({ prompt, opts });
        return Promise.resolve({
          output: "ok",
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
        });
      },
    }),
    story: makeStory({ id: "US-001" }),
    config: makeNaxConfig(),
    featureName: "ctx-tools",
    workdir: WORKDIR,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
    ...overrides,
  };
}

function makeOptions(prompt: string, config: BuildHopCallbackContext["config"]): AgentRunOptions {
  return {
    prompt,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config,
  };
}

function only(dispatch: Dispatch[]): Dispatch {
  expect(dispatch).toHaveLength(1);
  const first = dispatch[0];
  if (!first) throw new Error("no dispatch recorded");
  return first;
}

let origCreateRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origWriteManifest: typeof _buildHopCallbackDeps.writeRebuildManifest;
let origRebuild: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origWriteManifest = _buildHopCallbackDeps.writeRebuildManifest;
  origRebuild = _buildHopCallbackDeps.rebuildForAgent;
  _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
  // A REAL runtime — createContextToolRuntime returns undefined only when the
  // bundle configures no usable tool, and the preamble is gated on both.
  _buildHopCallbackDeps.createContextToolRuntime = mock(() => ({
    callTool: async () => "neighbour result",
  }));
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateRuntime;
  _buildHopCallbackDeps.writeRebuildManifest = origWriteManifest;
  _buildHopCallbackDeps.rebuildForAgent = origRebuild;
});

describe("buildHopCallback — context pull tools reach the agent (nax#1744)", () => {
  test("advertises the bundle's pull tools in the dispatched prompt", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    const { prompt } = only(dispatch);
    expect(prompt).toContain("implement US-001");
    expect(prompt).toContain("Context Pull Tools");
    expect(prompt).toContain("query_neighbor");
    // The agent also needs the call syntax, not just the tool name.
    expect(prompt).toContain("<nax_tool_call");
  });

  test("installs an interaction handler even with no interactionBridge", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    // Without this, sendPrompt falls back to NO_OP_INTERACTION_HANDLER and a
    // well-formed <nax_tool_call> is never answered.
    expect(only(dispatch).opts.interactionHandler).toBeDefined();
  });

  test("raises the turn budget so a tool round-trip has room", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    // Mirrors session-run-hop.ts: a single turn leaves no room to answer a call.
    expect(only(dispatch).opts.maxTurns).toBe(10);
  });

  test("returns the advertised prompt so the audit records what the agent saw", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    const hop = await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    expect(hop.prompt).toContain("query_neighbor");
    expect(hop.prompt).toBe(only(dispatch).prompt);
  });

  test("applies the preamble AFTER the swap-handoff rewrite, not before", async () => {
    const rebuilt = makeBundle([QUERY_NEIGHBOR]);
    _buildHopCallbackDeps.rebuildForAgent = mock(() => rebuilt);
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);
    const failure = { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "429" } as const;

    await cb("codex", makeBundle([QUERY_NEIGHBOR]), { kind: "swap", failure } satisfies HopKind, options);

    const { prompt } = only(dispatch);
    // The swap handoff rewrites the prompt wholesale; a preamble applied before
    // it would be discarded, leaving the fallback agent with no tools.
    expect(prompt).toContain("query_neighbor");
  });

  test("leaves the prompt and turn budget untouched when the bundle has no pull tools", async () => {
    _buildHopCallbackDeps.createContextToolRuntime = mock(() => undefined);
    const dispatch: Dispatch[] = [];
    const ctx = makeCtx(dispatch);
    const options = makeOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([]), { kind: "primary" } satisfies HopKind, options);

    const { prompt, opts } = only(dispatch);
    expect(prompt).toBe("implement US-001");
    expect(prompt).not.toContain("Context Pull Tools");
    expect(opts.maxTurns).toBeUndefined();
  });
});
