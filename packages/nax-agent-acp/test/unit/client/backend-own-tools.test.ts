/**
 * Codex and Cursor accept embedder tools (acp-tools-codex-cursor US-002): they have no
 * pre-approval channel, so session/new carries the tool host's server entry and no
 * `_meta`. An agent with neither a pre-approval channel nor an MCP call identity
 * (gemini, opencode, pi), or one that does not advertise HTTP MCP, still refuses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import {
  CODEX_CONFIG_OPTIONS,
  CURSOR_CONFIG_OPTIONS,
  type FakeScript,
  type FakeStep,
} from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

/** Ambient secret-named env vars, held out of the resolved agent env so the suite stays hermetic (env.ts SECRET_KEY). */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const ambientEnv: [string, string][] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-own-tools-");
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SECRET_KEY.test(key)) {
      ambientEnv.push([key, value]);
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
  for (const [key, value] of ambientEnv.splice(0)) process.env[key] = value;
});

const LOOKUP: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  approval: "never",
  run: async () => ({ content: "found" }),
};

const HTTP: FakeScript = { capabilities: { mcpCapabilities: { http: true } } };

function scriptFor(agent: AcpBackendOptions["agent"], extra: FakeScript): FakeScript {
  return {
    agentInfo: { name: `${String(agent)}-acp`, version: "1.0.0" },
    ...(agent === "cursor" ? { configOptions: CURSOR_CONFIG_OPTIONS } : { configOptions: CODEX_CONFIG_OPTIONS }),
    ...extra,
  };
}

async function open(agent: AcpBackendOptions["agent"], profile: AgentSessionProfile, extra: FakeScript = HTTP) {
  const fake = inMemoryAgent(scriptFor(agent, extra));
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
    profile,
    workdir,
    tools: [LOOKUP],
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

async function refused(agent: AcpBackendOptions["agent"], extra: FakeScript) {
  const fake = inMemoryAgent(scriptFor(agent, extra));
  _acpBackendDeps.launch = fake.launch;
  const err = sessionError(
    await rejection(
      createAgentSession({
        backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
        profile: "full",
        workdir,
        tools: [LOOKUP],
        transcriptStore: createMemoryTranscriptStore(),
      }),
    ),
  );
  return { fake, err };
}

describe("codex accepts embedder tools without pre-approval", () => {
  test("AC-12/13/14: read opens; session/new has one http server named nax-<8 hex> and no _meta", async () => {
    const o = await open("codex", "read");
    const [created] = o.fake.callsTo("session/new") as { mcpServers: { type: string; name: string }[] }[];
    expect(created?.mcpServers).toHaveLength(1);
    expect(created?.mcpServers[0]?.type).toBe("http");
    expect(created?.mcpServers[0]?.name).toMatch(/^nax-[0-9a-f]{8}$/);
    expect(created !== undefined && "_meta" in created).toBe(false);
  });

  test("AC-18: without HTTP MCP: CAPABILITY_UNSUPPORTED tools, no session/new", async () => {
    const { fake, err } = await refused("codex", {});
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.callsTo("session/new")).toEqual([]);
  });
});

describe("cursor accepts embedder tools without pre-approval", () => {
  test("AC-15/16: full opens, and the agent's mcpCall for lookup gets an mcp-result", async () => {
    const step: FakeStep = { kind: "mcpCall", tool: "lookup", input: { q: "acp" } };
    const o = await open("cursor", "full", { ...HTTP, turns: [{ steps: [step, { kind: "text", text: "done" }] }] });
    const events = await driveTurn(o.session, "look it up");
    expect(endOf(events).status).toBe("completed");
    expect(o.fake.callsTo("mcp-result")).toMatchObject([
      { tool: "lookup", result: { content: [{ type: "text", text: "found" }] } },
    ]);
  });

  test("AC-19: without HTTP MCP: CAPABILITY_UNSUPPORTED tools", async () => {
    const { err } = await refused("cursor", {});
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
  });
});

describe("agents with no pre-approval and no MCP call identity still refuse tools", () => {
  test.each(["gemini", "opencode", "pi"] as const)(
    "%s: CAPABILITY_UNSUPPORTED tools, no session/new",
    async (agent) => {
      const { fake, err } = await refused(agent, HTTP);
      expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
      expect(err.context).toMatchObject({ capability: "tools" });
      expect(fake.callsTo("session/new")).toEqual([]);
    },
  );
});
