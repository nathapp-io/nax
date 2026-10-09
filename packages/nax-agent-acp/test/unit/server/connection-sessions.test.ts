import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentApp,
  type ClientCapabilities,
  type ClientContext,
  client,
  PROTOCOL_VERSION,
  type PromptRequest,
  RequestError,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { buildAgentApp } from "#src/server/connection";
import type { OpenedSession } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { FAR_EXPIRY, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/cfg/s",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [],
  catalogOverrides: [],
  mcpConnectTimeoutSeconds: 30,
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-sessions-");
});
afterEach(() => cleanupTempDir(dir));

function app(scriptsFor: (sessionId: string) => readonly Script[], open?: () => Promise<OpenedSession>) {
  const { logger, lines } = recordingLogger();
  let next = 0;
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession:
      open ??
      (async (request) => ({
        session: fakeAgentSession(request.sessionId, scriptsFor(request.sessionId)).session,
        doc: null,
      })),
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts: createMemoryTranscriptStore(),
    newId: () => {
      next += 1;
      return `s${next}`;
    },
    now: () => new Date(),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return { agentApp: buildAgentApp({ version: "9.9.9", registry, logger }), lines };
}

const say = (words: string): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: words };
    yield turnEnd("completed");
  };

const waitForCancel: Script = async function* ({ cancelled }) {
  yield { type: "text_delta", round: 1, text: "working" };
  await cancelled;
  yield turnEnd("cancelled");
};

const editAsk: Script = async function* ({ reply }) {
  yield { type: "tool_call", callId: "c1", name: "Edit", input: { path: "a.ts", old_string: "a", new_string: "b" } };
  yield {
    type: "approval_requested",
    requestId: "r1",
    callId: "c1",
    tool: "Edit",
    summary: "Edit a.ts",
    reason: "ask",
    expiresAt: FAR_EXPIRY,
  };
  const got = await reply("r1");
  const allowed = got !== "cancelled" && "decision" in got && got.decision === "allow";
  yield { type: "text_delta", round: 2, text: allowed ? "applied" : "skipped" };
  yield turnEnd("completed");
};

const asksQuestion: Script = async function* ({ reply }) {
  yield { type: "question", requestId: "q1", text: "Which env?", expiresAt: FAR_EXPIRY };
  const got = await reply("q1");
  yield { type: "text_delta", round: 1, text: got !== "cancelled" && "text" in got ? got.text : "" };
  yield turnEnd("completed");
};

function texts(updates: readonly SessionNotification[], sessionId: string): string {
  return updates
    .filter((n) => n.sessionId === sessionId)
    .map((n) =>
      n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? n.update.content.text : "",
    )
    .join("");
}

async function connect<T>(
  agentApp: AgentApp,
  work: (agent: ClientContext, updates: SessionNotification[]) => Promise<T>,
  capabilities: ClientCapabilities = {},
): Promise<T> {
  const updates: SessionNotification[] = [];
  return client({ name: "test" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest("session/request_permission", async () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }))
    .onRequest("elicitation/create", async () => ({ action: "accept", content: { answer: "staging" } }))
    .connectWith(agentApp, async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
      return work(agent, updates);
    });
}

const prompt = (sessionId: string, text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

describe("session/new + session/prompt over a real SDK connection", () => {
  test("streams the turn and ends end_turn", async () => {
    const { agentApp } = app(() => [say("hello")]);
    const result = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const response = await agent.request("session/prompt", prompt(sessionId, "hi"));
      return { sessionId, response, text: texts(updates, sessionId) };
    });
    expect(result.sessionId).toBe("s1");
    expect(result.response.stopReason).toBe("end_turn");
    expect(result.text).toBe("hello");
  });

  test("the session/new response carries modes and config options (S5-3)", async () => {
    const { agentApp } = app(() => []);
    const response = await connect(agentApp, (agent) => agent.request("session/new", { cwd: "/w", mcpServers: [] }));
    expect(response).toMatchObject({ sessionId: "s1", modes: { currentModeId: "ask" } });
    expect(response.configOptions?.map((o) => o.id)).toEqual(["model", "bashApproval"]);
  });

  test("a permission round trip through the client's handler", async () => {
    const { agentApp } = app(() => [editAsk]);
    const text = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      await agent.request("session/prompt", prompt(sessionId, "edit"));
      return texts(updates, sessionId);
    });
    expect(text).toBe("applied");
  });

  test("a question goes to elicitation when the client declares it", async () => {
    const { agentApp } = app(() => [asksQuestion]);
    const text = await connect(
      agentApp,
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/prompt", prompt(sessionId, "go"));
        return texts(updates, sessionId);
      },
      { elicitation: { form: {} } },
    );
    expect(text).toBe("staging");
  });

  test("session/cancel arrives during a running prompt and ends it cancelled", async () => {
    const { agentApp } = app(() => [waitForCancel]);
    const stop = await connect(agentApp, async (agent, updates) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const running = agent.request("session/prompt", prompt(sessionId, "go"));
      await waitForCondition(() => texts(updates, sessionId) !== "");
      await agent.notify("session/cancel", { sessionId });
      return (await running).stopReason;
    });
    expect(stop).toBe("cancelled");
  });

  test("two sessions prompt at once; a second prompt on one session is turn in progress", async () => {
    const { agentApp } = app((id) => (id === "s1" ? [waitForCancel] : [say("two")]));
    const result = await connect(agentApp, async (agent, updates) => {
      const a = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const b = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const first = agent.request("session/prompt", prompt(a.sessionId, "1"));
      await waitForCondition(() => texts(updates, a.sessionId) !== "");
      const busy = await agent.request("session/prompt", prompt(a.sessionId, "again")).catch((e: unknown) => e);
      const second = await agent.request("session/prompt", prompt(b.sessionId, "2"));
      await agent.notify("session/cancel", { sessionId: a.sessionId });
      return { busy, second: second.stopReason, first: (await first).stopReason, bText: texts(updates, b.sessionId) };
    });
    expect(result.busy instanceof RequestError ? result.busy.code : 0).toBe(-32600);
    expect(result.second).toBe("end_turn");
    expect(result.bText).toBe("two");
    expect(result.first).toBe("cancelled");
  });
});

describe("errors over the connection (spec §7)", () => {
  test("a prompt for an unknown session is resource_not_found", async () => {
    const { agentApp } = app(() => []);
    const error = await connect(agentApp, (agent) =>
      agent.request("session/prompt", prompt("nope", "x")).catch((e: unknown) => e),
    );
    expect(error instanceof RequestError ? error.code : 0).toBe(-32002);
  });

  test("a cancel for an unknown session is ignored", async () => {
    const { agentApp, lines } = app(() => [say("ok")]);
    const stop = await connect(agentApp, async (agent) => {
      await agent.notify("session/cancel", { sessionId: "nope" });
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      return (await agent.request("session/prompt", prompt(sessionId, "x"))).stopReason;
    });
    expect(stop).toBe("end_turn");
    expect(lines.some((l) => l.level === "debug" && l.data?.sessionId === "nope")).toBe(true);
  });

  test("an unexpected failure is internal_error with the message only, logged, and the connection keeps serving", async () => {
    const { agentApp, lines } = app(
      () => [],
      async () => Promise.reject(new Error("disk full")),
    );
    const result = await connect(agentApp, async (agent) => {
      const failed = await agent.request("session/new", { cwd: "/w", mcpServers: [] }).catch((e: unknown) => e);
      const again = await agent.request("session/new", { cwd: "relative", mcpServers: [] }).catch((e: unknown) => e);
      return { failed, again };
    });
    expect(result.failed instanceof RequestError ? result.failed.message : "").toBe("Internal error: disk full");
    expect(result.again instanceof RequestError ? result.again.code : 0).toBe(-32602);
    expect(lines.some((l) => l.level === "error" && l.data?.error === "disk full")).toBe(true);
  });
});
