import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { createMemoryTranscriptStore, createSessionStorage, NaxError, type TranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { buildAgentApp } from "#src/server/connection";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";
import { setupRegistry } from "#test/helpers/registry-setup";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5" },
  ],
  catalogOverrides: [],
  mcpConnectTimeoutSeconds: 30,
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-persistence-");
});
afterEach(() => cleanupTempDir(dir));

function app(scriptsFor: (transcripts: TranscriptStore, sessionId: string) => readonly Script[]): AgentApp {
  const transcripts = createMemoryTranscriptStore();
  const { logger } = recordingLogger();
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => ({
      session: fakeAgentSession(request.sessionId, scriptsFor(transcripts, request.sessionId)).session,
      doc: await transcripts.load(request.sessionId),
    }),
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts,
    newId: () => "s1",
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return buildAgentApp({ version: "9.9.9", registry, logger });
}

/** A turn that leaves a stored transcript behind, as the real loop would. */
const remembers = (transcripts: TranscriptStore, sessionId: string): Script =>
  async function* () {
    await transcripts.save(sessionId, {
      savedAt: "x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    yield { type: "text_delta", round: 1, text: "hello" };
    yield turnEnd("completed");
  };

const waitForCancel: Script = async function* ({ cancelled }) {
  yield { type: "text_delta", round: 1, text: "working" };
  await cancelled;
  yield turnEnd("cancelled");
};

const prompt = (sessionId: string, text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

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
    .onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .connectWith(agentApp, async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
      return work(agent, updates);
    });
}

const codeOf = (error: unknown): number => (error instanceof RequestError ? error.code : 0);

describe("shared storage over the SDK connection", () => {
  async function withRegistry(work: (agent: ClientContext, setup: ReturnType<typeof setupRegistry>) => Promise<void>) {
    const setup = setupRegistry(dir, OPTIONS, { isAlive: (pid) => pid === 4242 });
    const { logger } = recordingLogger();
    try {
      await connect(buildAgentApp({ version: "9.9.9", registry: setup.registry, logger }), (agent) =>
        work(agent, setup),
      );
    } finally {
      await setup.registry.closeAll();
    }
  }

  test("new -> list returns id and cwd alongside metadata written without an ACP create", async () => {
    await withRegistry(async (agent, setup) => {
      await setup.storage.writeMeta({
        schemaVersion: 1,
        sessionId: "external",
        cwd: "/external",
        mode: "ask",
        model: "anthropic/claude-sonnet-5-5",
        bashApproval: "gated",
        title: null,
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: null,
      });
      const created = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const listed = await agent.request("session/list", {});
      expect(listed.sessions).toContainEqual(expect.objectContaining({ sessionId: created.sessionId, cwd: "/w" }));
      expect(listed.sessions).toContainEqual({
        sessionId: "external",
        cwd: "/external",
        title: null,
        updatedAt: "2026-10-09T00:00:00.000Z",
      });
    });
  });

  test.each(["session/load", "session/resume"] as const)(
    "%s preserves a foreign legacy lock refusal",
    async (method) => {
      await withRegistry(async (agent, setup) => {
        await setup.storage.writeMeta({
          schemaVersion: 1,
          sessionId: "locked",
          cwd: "/w",
          mode: "ask",
          model: "anthropic/claude-sonnet-5-5",
          bashApproval: "gated",
          title: null,
          createdAt: "2026-10-09T00:00:00.000Z",
          updatedAt: null,
        });
        await writeFile(join(dir, "locked.lock"), JSON.stringify({ pid: 4242, startedAt: "x" }));
        const error = await agent
          .request(method, { sessionId: "locked", cwd: "/w", mcpServers: [] })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RequestError);
        expect(error).toMatchObject({ code: -32600, message: expect.stringContaining("session in use by pid 4242") });
      });
    },
  );

  test("list preserves invalid cursor text and code at the single wire boundary", async () => {
    await withRegistry(async (agent, setup) => {
      const neutral = await setup.storage.list({ cursor: "bad" }).catch((e: unknown) => e);
      expect(neutral).toBeInstanceOf(NaxError);
      expect(neutral).toMatchObject({ code: "SESSION_LIST_CURSOR_INVALID" });
      const error = await agent.request("session/list", { cursor: "bad" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32602, message: expect.stringContaining("invalid cursor") });
    });
  });
});

describe("persistence methods over a real SDK connection (S5-3)", () => {
  test("new -> prompt -> close -> list -> load replays the stored transcript", async () => {
    const result = await connect(
      app((transcripts, id) => [remembers(transcripts, id)]),
      async (agent, updates) => {
        const created = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/prompt", prompt(created.sessionId, "hi"));
        await agent.request("session/close", { sessionId: created.sessionId });
        const listed = await agent.request("session/list", { cwd: "/w" });
        updates.length = 0;
        const loaded = await agent.request("session/load", { sessionId: created.sessionId, cwd: "/w", mcpServers: [] });
        return { created, listed, loaded, kinds: updates.map((n) => n.update.sessionUpdate) };
      },
    );
    expect(result.created).toMatchObject({ sessionId: "s1", modes: { currentModeId: "ask" } });
    expect(result.listed.sessions).toEqual([
      { sessionId: "s1", cwd: "/w", title: "hi", updatedAt: "2026-10-09T01:00:00.000Z" },
    ]);
    expect(result.loaded).toMatchObject({ modes: { currentModeId: "ask" } });
    expect(result.kinds).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  test("set_mode and set_config_option answer and send their updates", async () => {
    const result = await connect(
      app(() => []),
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        await agent.request("session/set_mode", { sessionId, modeId: "read" });
        const changed = await agent.request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: "anthropic/claude-haiku-4-5",
        });
        return { changed, kinds: updates.map((n) => n.update.sessionUpdate) };
      },
    );
    expect(result.kinds).toContain("current_mode_update");
    expect(result.kinds).toContain("config_option_update");
    expect(result.changed.configOptions).toHaveLength(3);
    expect(result.changed.configOptions[1]).toMatchObject({ id: "model", currentValue: "anthropic/claude-haiku-4-5" });
  });

  test("set_mode mid-turn is -32600; resume of an open session answers; delete then load is -32002", async () => {
    const result = await connect(
      app(() => [waitForCancel]),
      async (agent, updates) => {
        const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
        const running = agent.request("session/prompt", prompt(sessionId, "go"));
        await waitForCondition(() => updates.length > 0);
        const busy = await agent.request("session/set_mode", { sessionId, modeId: "read" }).catch((e: unknown) => e);
        await agent.notify("session/cancel", { sessionId });
        const stop = (await running).stopReason;
        const resumed = await agent.request("session/resume", { sessionId, cwd: "/w" });
        await agent.request("session/delete", { sessionId });
        const missing = await agent
          .request("session/load", { sessionId, cwd: "/w", mcpServers: [] })
          .catch((e: unknown) => e);
        return { busy: codeOf(busy), stop, resumed, missing: codeOf(missing) };
      },
    );
    expect(result.busy).toBe(-32600);
    expect(result.stop).toBe("cancelled");
    expect(result.resumed).toMatchObject({ modes: { currentModeId: "ask" } });
    expect(result.missing).toBe(-32002);
  });
});
