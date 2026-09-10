import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const WORKDIR = "/tmp/nax-endpoint-reuse";
const NAME = "nax-endpoint-reuse-implementer";

function request(modelId: string, agentName = "native"): OpenSessionRequest {
  return {
    agentName,
    role: "implementer",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: modelId.split("/")[0] ?? "unknown", model: modelId },
    timeoutSeconds: 30,
  };
}

/** Adapter that echoes the endpoint it was opened with, and counts closes. */
function tracked() {
  const opened: OpenSessionOpts[] = [];
  const closed: SessionHandle[] = [];
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts): Promise<SessionHandle> => {
      opened.push(opts);
      return { id: name, agentName: opts.agentName, modelDef: opts.modelDef };
    }),
    closeSession: mock(async (handle: SessionHandle) => {
      closed.push(handle);
    }),
  });
  return { adapter, opened, closed };
}

describe("SessionManager endpoint-aware reuse (nax#1965)", () => {
  test("a same-agent re-open with a different model dispatches the new model", async () => {
    const { adapter, opened } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    const hop1 = await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    expect(hop1.modelDef?.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(opened).toHaveLength(2);
  });

  test("it closes the previous physical session rather than orphaning it", async () => {
    const { adapter, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    expect(closed).toHaveLength(1);
    expect(closed[0]?.modelDef?.model).toBe("minimax/MiniMax-M3");
  });

  test("a cross-agent re-open closes the prior handle (acp -> native leak)", async () => {
    const { adapter, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("sonnet[medium]", "claude"));
    const hop1 = await sm.openSession(NAME, request("minimax/MiniMax-M3", "native"));

    expect(hop1.agentName).toBe("native");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.agentName).toBe("claude");
  });

  test("an unchanged endpoint still reuses the live handle", async () => {
    const { adapter, opened, closed } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    const first = await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    const second = await sm.openSession(NAME, request("minimax/MiniMax-M3"));

    expect(second).toBe(first);
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
  });

  test("the single-flight guard survives a close-then-reopen", async () => {
    const { adapter } = tracked();
    const sm = new SessionManager({ getAdapter: () => adapter });

    await sm.openSession(NAME, request("minimax/MiniMax-M3"));
    await sm.openSession(NAME, request("opencode-go/deepseek-v4-flash[high]"));

    // A third open must still be permitted: the busy marker was re-armed and then
    // released, not left set by the intermediate closeSession.
    await expect(sm.openSession(NAME, request("openrouter/z-ai/glm-5.3-flash[high]"))).resolves.toBeDefined();
  });
});
