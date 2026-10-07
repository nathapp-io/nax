import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  ASK_DENIED_REASON,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type EmbedderToolContext,
  type SessionEvent,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { z } from "zod";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { approvalReason, NO_TURN_TEXT } from "#src/client/tool-calls";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { mcpClient } from "#test/helpers/mcp-client";
import { driveTurn, endOf, indexOfType } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-tools-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

/** Claude as the fake offers it, with HTTP MCP. */
const HTTP_CLAUDE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { mcpCapabilities: { http: true } },
};

interface Ran {
  readonly input: unknown;
  readonly ctx: EmbedderToolContext;
}

function lookupTool(approval: "never" | "always", ran: Ran[]): EmbedderTool {
  return {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval,
    describe: (input) => `look up ${JSON.stringify(input)}`,
    run: async (input, ctx) => {
      ran.push({ input, ctx });
      return { content: `found: ${JSON.stringify(input)}` };
    },
  };
}

function hangingTool(seen: EmbedderToolContext[]): EmbedderTool {
  return {
    name: "slow",
    description: "Never finishes and ignores its signal",
    inputSchema: { type: "object" },
    approval: "never",
    run: (_input, ctx) => {
      seen.push(ctx);
      return new Promise(() => {});
    },
  };
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
  readonly store: TranscriptStore;
}

async function open(
  profile: AgentSessionProfile,
  steps: readonly FakeStep[],
  tools: readonly EmbedderTool[],
  script: FakeScript = {},
  agent: AcpBackendOptions["agent"] = "claude",
): Promise<Opened> {
  const fake = inMemoryAgent({ ...HTTP_CLAUDE, turns: [{ steps }], ...script });
  _acpBackendDeps.launch = fake.launch;
  const store = createMemoryTranscriptStore();
  const session = await createAgentSession({
    backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
    profile,
    ...(profile === "none" ? {} : { workdir }),
    tools,
    transcriptStore: store,
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session, store };
}

const NEW_SESSION = z.object({
  mcpServers: z.array(
    z.object({
      type: z.literal("http"),
      name: z.string(),
      url: z.string(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

/** The host's url and token, as the agent received them in session/new. */
function hostOf(fake: InMemoryAgent): { url: string; token: string } {
  const server = NEW_SESSION.parse(fake.callsTo("session/new")[0]).mcpServers[0];
  if (server === undefined) throw new Error("session/new carried no MCP server");
  const auth = server.headers.find((h) => h.name === "Authorization")?.value ?? "";
  return { url: server.url, token: auth.replace(/^Bearer /, "") };
}

const results = (o: Opened) => o.fake.callsTo("mcp-result");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const approvals = (events: readonly SessionEvent[]) => events.filter((e) => e.type.startsWith("approval_"));
const call = (input: Record<string, unknown> = { q: "acp" }): FakeStep => ({ kind: "mcpCall", tool: "lookup", input });

describe("approval never (spec §6.6)", () => {
  test("full: session/new carries the host and the pre-approval rule; the agent's call runs the tool", async () => {
    const ran: Ran[] = [];
    const o = await open("full", [call(), { kind: "text", text: "done" }], [lookupTool("never", ran)]);
    // structuredClone: Bun's toMatchObject with asymmetric matchers mutates the
    // received object, and the fake agent still reads these live session/new params.
    expect(structuredClone(o.fake.callsTo("session/new")[0])).toMatchObject({
      cwd: workdir,
      mcpServers: [
        {
          type: "http",
          name: "nax",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) }],
        },
      ],
      _meta: { claudeCode: { options: { allowedTools: ["mcp__nax__lookup"] } } },
    });
    const events = await driveTurn(o.session, "look it up");
    expect(ran.map((r) => [r.input, r.ctx.sessionId, r.ctx.toolCallId])).toEqual([[{ q: "acp" }, "s-1", "mcp-1"]]);
    expect(results(o)).toMatchObject([
      { tool: "lookup", result: { content: [{ type: "text", text: 'found: {"q":"acp"}' }] } },
    ]);
    expect(approvals(events)).toEqual([]);
    expect(endOf(events).status).toBe("completed");
  });

  test("read: default mode, and the tool still runs without any approval event", async () => {
    const ran: Ran[] = [];
    const o = await open("read", [call()], [lookupTool("never", ran)]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    const events = await driveTurn(o.session, "x");
    expect(ran).toHaveLength(1);
    expect(approvals(events)).toEqual([]);
  });
});

describe("approval always: the caller decides under every profile (spec §6.6)", () => {
  test("none: approval_requested names mcp-1, the tool and the summary; allow runs it", async () => {
    const ran: Ran[] = [];
    const o = await open("none", [call()], [lookupTool("always", ran)]);
    const events = await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "allow" });
    });
    expect(find(events, "approval_requested")).toMatchObject({
      callId: "mcp-1",
      tool: "lookup",
      summary: 'look up {"q":"acp"}',
      reason: approvalReason("lookup"),
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(ran).toHaveLength(1);
  });

  test("ask, denied: the agent gets a denied tool error and the tool does not run", async () => {
    const ran: Ran[] = [];
    const o = await open("ask", [call()], [lookupTool("always", ran)]);
    await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(ran).toEqual([]);
    expect(results(o)).toMatchObject([
      { result: { content: [{ type: "text", text: `Denied: ${ASK_DENIED_REASON}` }], isError: true } },
    ]);
  });
});

describe("a call that outlives its turn (Review Focus 1)", () => {
  test("cancel while the approval is pending: resolved cancelled before turn_end; the tool never runs", async () => {
    const ran: Ran[] = [];
    const o = await open(
      "ask",
      [{ kind: "mcpCall", tool: "lookup", input: {}, detached: true }, { kind: "waitForCancel" }],
      [lookupTool("always", ran)],
    );
    const events = await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.cancel();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("cancelled");
    expect(ran).toEqual([]);
    await waitForCondition(() => results(o).length === 1, 3_000);
    expect(results(o)[0]).toMatchObject({ result: { isError: true } });
  });

  test("cancel during a run that ignores its signal: the turn ends; the run's signal aborts; the agent gets abandoned", async () => {
    const seen: EmbedderToolContext[] = [];
    const o = await open(
      "full",
      [{ kind: "mcpCall", tool: "slow", input: {}, detached: true }, { kind: "waitForCancel" }],
      [hangingTool(seen)],
    );
    const turn = driveTurn(o.session, "x");
    await waitForCondition(() => seen.length === 1, 3_000);
    o.session.cancel();
    const events = await turn;
    expect(endOf(events).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    await waitForCondition(() => results(o).length === 1, 3_000);
    expect(results(o)[0]).toMatchObject({
      result: { content: [{ type: "text", text: 'Tool "slow" was abandoned: the turn ended.' }], isError: true },
    });
  });

  test("the agent process dies during a run: the turn errors and the run's signal aborts", async () => {
    const seen: EmbedderToolContext[] = [];
    const o = await open(
      "full",
      [{ kind: "mcpCall", tool: "slow", input: {}, detached: true }, { kind: "hang" }],
      [hangingTool(seen)],
    );
    const turn = driveTurn(o.session, "x");
    await waitForCondition(() => seen.length === 1, 3_000);
    o.fake.crash();
    const events = await turn;
    expect(endOf(events).status).toBe("errored");
    expect(seen[0]?.signal.aborted).toBe(true);
  });
});

describe("outside a turn, and after close (Review Focus 3, 4)", () => {
  test("between turns: no-turn error, nothing runs; after close the port refuses connections", async () => {
    const ran: Ran[] = [];
    const o = await open("full", [{ kind: "text", text: "ok" }], [lookupTool("never", ran)]);
    await driveTurn(o.session, "x");
    const { url, token } = hostOf(o.fake);
    const client = await mcpClient(url, token);
    try {
      expect(await client.callTool({ name: "lookup", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: NO_TURN_TEXT }],
        isError: true,
      });
    } finally {
      await client.close();
    }
    expect(ran).toEqual([]);
    await o.session.close();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("the token stays secret (Review Focus 3)", () => {
  test("never in the transcript or an event; an agent error echoing the header is redacted", async () => {
    const o = await open(
      "full",
      [{ kind: "fail", failure: { code: -32603, message: "agent saw" }, echoMcpAuth: true }],
      [lookupTool("never", [])],
    );
    const { token } = hostOf(o.fake);
    const events = await driveTurn(o.session, "x");
    const end = endOf(events);
    expect(end.status).toBe("errored");
    expect(end.error?.message).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(await o.store.load("s-1"))).not.toContain(token);
  });
});

describe("agents that cannot take tools (D4-j)", () => {
  async function refused(agent: AcpBackendOptions["agent"], script: FakeScript) {
    const fake = inMemoryAgent(script);
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
          profile: "full",
          workdir,
          tools: [lookupTool("never", [])],
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    return { fake, err };
  }

  test("claude without HTTP MCP: CAPABILITY_UNSUPPORTED tools after initialize, no session/new", async () => {
    const { fake, err } = await refused("claude", { ...HTTP_CLAUDE, capabilities: {} });
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.callsTo("initialize")).toHaveLength(1);
    expect(fake.callsTo("session/new")).toEqual([]);
  });

  test("codex (no pre-approval): CAPABILITY_UNSUPPORTED tools", async () => {
    const { err } = await refused("codex", { capabilities: { mcpCapabilities: { http: true } } });
    expect(err.context).toMatchObject({ capability: "tools" });
  });

  test("a failed open leaves no listening host behind", async () => {
    const fake = inMemoryAgent({ ...HTTP_CLAUDE, newSessionFailure: { code: -32603, message: "no" } });
    _acpBackendDeps.launch = fake.launch;
    await rejection(
      createAgentSession({
        backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-agent" }),
        profile: "full",
        workdir,
        tools: [lookupTool("never", [])],
        transcriptStore: createMemoryTranscriptStore(),
      }),
    );
    const { url } = hostOf(fake);
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});
