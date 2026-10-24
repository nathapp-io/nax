/**
 * The issue's own entry point (spec §Motivation): `session/set_mode` or
 * `session/set_config_option` overlapped by `session/close`, through the real
 * ACP RPC handlers. The close waits for the switch's gated replacement open,
 * the switch rejects `session is closed`, and nothing is resurrected.
 */
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
import { waitForCondition, withTimeout } from "@nathapp/nax-test-kit/bun/timeout";
import { buildAgentApp } from "#src/server/connection";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, type SessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { type FakeAgentSession, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const SETTLE_MS = 2_000;

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

const say = (words: string): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: words };
    yield turnEnd("completed");
  };

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-close-switch-");
});
afterEach(() => cleanupTempDir(dir));

interface Harness {
  readonly agentApp: AgentApp;
  readonly registry: SessionRegistry;
  /** The fakes in openSession order: [the created session, the switch's replacement, ...]. */
  readonly fakes: FakeAgentSession[];
  readonly opened: OpenSessionRequest[];
  /** Releases the switch's replacement open. The first open (session/new) never waits. */
  open(): void;
}

function harness(): Harness {
  const opened: OpenSessionRequest[] = [];
  const fakes: FakeAgentSession[] = [];
  const gate = Promise.withResolvers<void>();
  const { logger } = recordingLogger();
  let next = 0;
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => {
      opened.push(request);
      if (opened.length >= 2) await gate.promise;
      const fake = fakeAgentSession(request.sessionId, [say("hi")]);
      fakes.push(fake);
      return { session: fake.session, doc: null };
    },
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts: createMemoryTranscriptStore(),
    newId: () => {
      next += 1;
      return `s${next}`;
    },
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return {
    agentApp: buildAgentApp({ version: "9.9.9", registry, logger }),
    registry,
    fakes,
    opened,
    open: () => gate.resolve(),
  };
}

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

/** Records a rejection instead of leaving it unhandled, so a gate release can precede the assertion. */
const observed = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const codeOf = (error: unknown): number => (error instanceof RequestError ? error.code : 0);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe("session/close overlapping a session/set_mode RPC", () => {
  test("closes the switch's replacement and leaves no session behind", async () => {
    const h = harness();
    const result = await connect(h.agentApp, async (agent) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const switching = observed(agent.request("session/set_mode", { sessionId, modeId: "read" }));
      await waitForCondition(() => h.opened.length === 2);
      const closing = observed(agent.request("session/close", { sessionId }));
      // The close has reached the switch (the old entry is still the registered one).
      await waitForCondition(() => h.registry.find(sessionId)?.isClosing() === true);
      // Pending, because the switch's replacement open is still gated.
      const beforeRelease = await Promise.race([closing.then(() => "settled"), Promise.resolve("pending")]);
      h.open();
      await withTimeout(closing, SETTLE_MS, "session/close did not resolve");
      const error = await withTimeout(switching, SETTLE_MS, "session/set_mode did not settle");
      const afterPrompt = await agent.request("session/prompt", prompt(sessionId, "hi")).catch((e: unknown) => e);
      return { sessionId, beforeRelease, error, afterPrompt };
    });
    expect(result.beforeRelease).toBe("pending");
    expect(h.registry.find(result.sessionId)).toBeUndefined();
    expect(messageOf(result.error)).toContain("session is closed");
    expect(h.fakes).toHaveLength(2);
    expect(h.fakes[1]?.closed()).toBe(true);
    expect(result.afterPrompt instanceof RequestError).toBe(true);
    expect(codeOf(result.afterPrompt)).toBe(-32002);
  });

  test("a prompt for the raced session is the same resource_not_found a later prompt gets", async () => {
    const h = harness();
    const codes = await connect(h.agentApp, async (agent) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const switching = observed(agent.request("session/set_mode", { sessionId, modeId: "read" }));
      await waitForCondition(() => h.opened.length === 2);
      const closing = observed(agent.request("session/close", { sessionId }));
      await waitForCondition(() => h.registry.find(sessionId)?.isClosing() === true);
      h.open();
      await withTimeout(closing, SETTLE_MS, "session/close did not resolve");
      await withTimeout(switching, SETTLE_MS, "session/set_mode did not settle");
      const first = await agent.request("session/prompt", prompt(sessionId, "one")).catch((e: unknown) => e);
      const again = await agent.request("session/prompt", prompt(sessionId, "two")).catch((e: unknown) => e);
      return { first: codeOf(first), again: codeOf(again), found: h.registry.find(sessionId) };
    });
    expect(codes.first).toBe(-32002);
    expect(codes.again).toBe(-32002);
    expect(codes.found).toBeUndefined();
  });
});

describe("session/close overlapping a session/set_config_option RPC", () => {
  test("a gated model change leaves no session in the registry", async () => {
    const h = harness();
    const result = await connect(h.agentApp, async (agent) => {
      const { sessionId } = await agent.request("session/new", { cwd: "/w", mcpServers: [] });
      const switching = observed(
        agent.request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: "anthropic/claude-haiku-4-5",
        }),
      );
      await waitForCondition(() => h.opened.length === 2);
      const closing = observed(agent.request("session/close", { sessionId }));
      await waitForCondition(() => h.registry.find(sessionId)?.isClosing() === true);
      h.open();
      await withTimeout(closing, SETTLE_MS, "session/close did not resolve");
      const error = await withTimeout(switching, SETTLE_MS, "session/set_config_option did not settle");
      return { sessionId, error };
    });
    expect(h.opened[1]).toMatchObject({ model: "anthropic/claude-haiku-4-5" });
    expect(h.registry.find(result.sessionId)).toBeUndefined();
    expect(messageOf(result.error)).toContain("session is closed");
  });
});
