/**
 * Three operations of one story walk the ladder together (nax#1965).
 *
 * The stub is the ADAPTER, nothing above it: SessionManager's live-handle cache,
 * AgentManager's candidate selection, the CooldownStore and the configured ladder
 * are all real. That is deliberate — every pre-existing fallback test stubbed the
 * session layer, which is exactly where the endpoint was being dropped.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeNaxConfig } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle } from "@/agents/types";
import { SessionManager } from "@/session/manager";

const SESSION = "nax-ladder-us1-implementer";

const MODELS = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
  claude: { balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
} as const;

function ladderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [
            { agent: "native", model: "powerful" },
            { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
            "claude",
          ],
        },
        maxHopsPerStory: 3,
      },
    },
    models: MODELS,
  });
}

/** Records every endpoint the adapter was actually asked to dispatch. */
function recordingAdapter() {
  const dispatched: Array<{ agent: string; model: string }> = [];
  const closed: SessionHandle[] = [];
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts): Promise<SessionHandle> => {
      dispatched.push({ agent: opts.agentName, model: opts.modelDef.model });
      return { id: name, agentName: opts.agentName, modelDef: opts.modelDef };
    }),
    closeSession: mock(async (handle: SessionHandle) => {
      closed.push(handle);
    }),
  });
  return { adapter, dispatched, closed };
}

describe("a story's ladder across three operations", () => {
  test("op 2 dispatches the endpoint op 1 swapped to, with THAT model on the handle", async () => {
    const { adapter, dispatched } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    // Op 1 opens on the primary (balanced), then swaps to rung 1 (powerful).
    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.powerful },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    // Op 2 (autofix-implementer — same warm session name and role) inherits rung 1.
    const hop = await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "rectification",
      modelDef: { provider: "unknown", model: MODELS.native.powerful },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.modelDef?.model).toBe(MODELS.native.powerful);
    expect(dispatched.map((d) => d.model)).toEqual([MODELS.native.balanced, MODELS.native.powerful]);
  });

  test("native -> claude closes the native handle and dispatches sonnet", async () => {
    const { adapter, dispatched, closed } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    const hop = await sm.openSession(SESSION, {
      agentName: "claude",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "anthropic", model: "sonnet[medium]" },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.agentName).toBe("claude");
    expect(dispatched.at(-1)).toEqual({ agent: "claude", model: "sonnet[medium]" });
    expect(closed.map((h) => h.agentName)).toEqual(["native"]);
  });

  test("claude -> native closes the acp handle rather than orphaning it", async () => {
    const { adapter, dispatched, closed } = recordingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter, config: ladderConfig() });

    await sm.openSession(SESSION, {
      agentName: "claude",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "anthropic", model: "sonnet[medium]" },
      timeoutSeconds: 30,
      storyId: "US-1",
    });
    const hop = await sm.openSession(SESSION, {
      agentName: "native",
      role: "implementer",
      workdir: "/w",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: MODELS.native.balanced },
      timeoutSeconds: 30,
      storyId: "US-1",
    });

    expect(hop.agentName).toBe("native");
    expect(dispatched.at(-1)).toEqual({ agent: "native", model: MODELS.native.balanced });
    expect(closed.map((h) => h.agentName)).toEqual(["claude"]);
  });
});
