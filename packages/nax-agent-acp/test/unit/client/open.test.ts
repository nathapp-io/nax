import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AgentSessionErrorCode, createMemoryTranscriptStore, type TranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createInboundRouter } from "#src/client/inbound";
import { openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, resolveAcpOptions } from "#src/client/options";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { openContext } from "#test/helpers/open-context";

const SECRET = "s3cr3t-token-value-0123";
let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-open-");
});

afterEach(() => cleanupTempDir(dir));

const CLAUDE_SCRIPT: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
};

// The SDK's agent-side param parsing fills clientCapabilities defaults, so the
// exact object we assert on must already carry them (see connection.test.ts).
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
};

function options(extra: Partial<AcpBackendOptions> = {}) {
  return resolveAcpOptions(
    { agent: "claude", allowUnsandboxed: true, command: "fake-claude", env: { MY_TOKEN: SECRET }, ...extra },
    { PATH: "/usr/bin" },
  );
}

async function openWith(script: FakeScript, extra: Partial<AcpBackendOptions> = {}, store?: TranscriptStore) {
  const fake = inMemoryAgent(script);
  const ctx = openContext(dir, store === undefined ? {} : { transcriptStore: store });
  const opened = openAcpSession(options(extra), ctx, createInboundRouter().handlers, fake.launch);
  return { fake, ctx, opened };
}

describe("openAcpSession: the happy path (spec §6.3 step 1)", () => {
  test("launches the explicit command in workdir with the resolved env, then initialize, session/new, mode", async () => {
    const { fake, ctx, opened } = await openWith(CLAUDE_SCRIPT);
    const acp = await opened;
    expect(fake.requests).toEqual([
      { command: "fake-claude", args: [], cwd: dir, env: { PATH: "/usr/bin", MY_TOKEN: SECRET } },
    ]);
    expect(fake.callsTo("initialize")).toEqual([{ protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }]);
    expect(fake.callsTo("session/new")).toEqual([{ cwd: dir, mcpServers: [] }]);
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    expect(acp.agentSessionId).toBe("fake-session-1");
    expect(acp.record).toMatchObject({ agentName: "claude-agent-acp", readOnlyMode: true });
    expect(await ctx.transcriptStore.load("session-1")).toMatchObject({
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", agentVersion: "0.85.1", cwd: dir },
      messages: [],
    });
    expect(fake.kills()).toBe(0);
  });

  test("model: applied after the mode through the model option", async () => {
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, { model: "sonnet" });
    await opened;
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
      { sessionId: "fake-session-1", configId: "model", value: "sonnet" },
    ]);
  });

  test("a registry agent launches the first candidate found on the agent env's PATH", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fake = inMemoryAgent({});
    const resolved = resolveAcpOptions(
      { agent: "gemini", allowUnsandboxed: true, env: { PATH: bin } },
      { PATH: "/usr/bin" },
    );
    const err = sessionError(
      await rejection(openAcpSession(resolved, openContext(dir), createInboundRouter().handlers, fake.launch)),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("gemini");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("openAcpSession: every failure after the spawn kills the agent (Review Focus 1)", () => {
  test.each<[string, FakeScript, Partial<AcpBackendOptions>, AgentSessionErrorCode]>([
    ["protocol version mismatch", { ...CLAUDE_SCRIPT, protocolVersion: 2 }, {}, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
    [
      "auth error at initialize",
      { initializeFailure: { code: -32000, message: "login" } },
      {},
      "AGENT_SESSION_AUTH_REQUIRED",
    ],
    [
      "auth error at session/new",
      { ...CLAUDE_SCRIPT, newSessionFailure: { code: -32000, message: "login" } },
      {},
      "AGENT_SESSION_AUTH_REQUIRED",
    ],
    [
      "other error at session/new",
      { ...CLAUDE_SCRIPT, newSessionFailure: { code: -32603, message: `boom ${SECRET}` } },
      {},
      "AGENT_SESSION_BACKEND_UNAVAILABLE",
    ],
    ["initialize timeout", { hangInitialize: true }, { initializeTimeoutMs: 30 }, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
    ["no mode option (claude)", { configOptions: [] }, {}, "AGENT_SESSION_CAPABILITY_UNSUPPORTED"],
    ["model not offered", CLAUDE_SCRIPT, { model: "gpt-9" }, "AGENT_SESSION_CAPABILITY_UNSUPPORTED"],
    ["empty agent session id", { ...CLAUDE_SCRIPT, sessionId: "" }, {}, "AGENT_SESSION_BACKEND_UNAVAILABLE"],
  ])("%s -> %s", async (_name, script, extra, code) => {
    const { fake, ctx, opened } = await openWith(script, extra);
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(SECRET);
    expect(fake.kills()).toBe(1);
    expect(await ctx.transcriptStore.load("session-1")).toBeNull();
  });

  test("capability refusals name the capability", async () => {
    const model = sessionError(await rejection((await openWith(CLAUDE_SCRIPT, { model: "gpt-9" })).opened));
    expect(model.context).toMatchObject({ capability: "model" });
    const mode = sessionError(await rejection((await openWith({ configOptions: [] })).opened));
    expect(mode.context).toMatchObject({ capability: "profile" });
  });

  test("a transcript save failure propagates and kills the agent", async () => {
    const inner = createMemoryTranscriptStore();
    const failing: TranscriptStore = {
      ...inner,
      save: async () => {
        throw new Error("disk full");
      },
    };
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, {}, failing);
    expect(String(await rejection(opened))).toContain("disk full");
    expect(fake.kills()).toBe(1);
  });
});

describe("openAcpSession: openSignal (close() during open)", () => {
  test("already aborted: AGENT_SESSION_CLOSED and nothing is launched", async () => {
    const fake = inMemoryAgent(CLAUDE_SCRIPT);
    const controller = new AbortController();
    controller.abort();
    const err = sessionError(
      await rejection(
        openAcpSession(
          options(),
          openContext(dir, { openSignal: controller.signal }),
          createInboundRouter().handlers,
          fake.launch,
        ),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.requests).toHaveLength(0);
  });

  test("aborted during a hung initialize: AGENT_SESSION_CLOSED and the agent is killed", async () => {
    const fake = inMemoryAgent({ hangInitialize: true });
    const controller = new AbortController();
    const opened = openAcpSession(
      options(),
      openContext(dir, { openSignal: controller.signal }),
      createInboundRouter().handlers,
      fake.launch,
    );
    setTimeout(() => controller.abort(), 20);
    expect(sessionError(await rejection(opened)).code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.kills()).toBe(1);
  });
});
