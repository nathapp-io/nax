/**
 * US-001 — a per-session tool host server name: `nax-<8 hex>`, generated once per
 * backend session, kept across a reconnect, used by Claude's pre-approval rules and
 * recognised by `parseToolHostToolName`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend, toolHostFor } from "#src/client/backend";
import { createInboundRouter } from "#src/client/inbound";
import { parseToolHostToolName as parseFromEntry, TOOL_HOST_SERVER_NAME as prefixFromEntry } from "#src/client/index";
import { rejectLocally } from "#src/client/permissions";
import { claudeSessionMeta, mcpToolRule, parseToolHostToolName } from "#src/client/pre-approval";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostServerName, type ToolHost, type ToolHostOptions } from "#src/client/tool-host";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { openContext } from "#test/helpers/open-context";
import { driveTurn } from "#test/helpers/session-events";

const NAME = "nax-0badc0de";
const SHAPE = /^nax-[0-9a-f]{8}$/;

const lookup: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: {} },
  approval: "never",
  run: async () => ({ content: "found" }),
};

function calls() {
  const scope = new AbortController();
  return createToolCalls({
    sessionId: "s-1",
    tools: [lookup],
    asks: {
      requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
      recordAutoDecision: () => {},
      askQuestion: async () => null,
      noteQuestion: () => {},
    },
    currentTurnId: () => "turn-1",
    turnSignal: () => scope.signal,
    secrets: [],
  });
}

describe("newToolHostServerName", () => {
  test("AC-1: nax- followed by exactly 8 lowercase hex characters", () => {
    expect(newToolHostServerName()).toMatch(SHAPE);
  });

  test("AC-2: two calls differ", () => {
    expect(newToolHostServerName()).not.toBe(newToolHostServerName());
  });
});

describe("createToolHost serverName", () => {
  const hosts: ToolHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
  });
  const make = (options?: ToolHostOptions): ToolHost => {
    const host = createToolHost(calls(), "token-1", options);
    hosts.push(host);
    return host;
  };

  test("AC-3: the option is the host's serverName", () => {
    expect(make({ serverName: NAME }).serverName).toBe(NAME);
  });

  test("AC-4: start() returns a server entry with that name", async () => {
    expect((await make({ serverName: NAME }).start()).name).toBe(NAME);
  });

  test("AC-5: without the option the host draws a fresh name", () => {
    expect(make().serverName).toMatch(SHAPE);
  });
});

describe("pre-approval rules on the session's name", () => {
  test("AC-6: mcpToolRule", () => {
    expect(mcpToolRule(NAME, "lookup")).toBe("mcp__nax-0badc0de__lookup");
  });

  test("AC-7: claudeSessionMeta", () => {
    expect(claudeSessionMeta("claudeCode.allowedTools", NAME, ["lookup"], undefined)).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__nax-0badc0de__lookup"] } },
    });
  });
});

describe("backend session: one name across open and reconnect", () => {
  const realLaunch = _acpBackendDeps.launch;
  const realName = _acpBackendDeps.newToolHostServerName;
  const sessions: AgentSession[] = [];
  let workdir: string;
  let drawn: number;

  const RESUMABLE: FakeScript = {
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    capabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
    turns: [{ steps: [{ kind: "text", text: "one" }] }],
    relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] },
  };

  beforeEach(() => {
    workdir = makeTempDir("acp-server-name-");
    drawn = 0;
    _acpBackendDeps.newToolHostServerName = () => {
      drawn += 1;
      return NAME;
    };
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
    _acpBackendDeps.launch = realLaunch;
    _acpBackendDeps.newToolHostServerName = realName;
    cleanupTempDir(workdir);
  });

  async function open(tools: readonly EmbedderTool[]) {
    const fake = inMemoryAgent(RESUMABLE);
    _acpBackendDeps.launch = fake.launch;
    const session = await createAgentSession({
      backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude" }),
      profile: "full",
      workdir,
      tools,
      transcriptStore: createMemoryTranscriptStore(),
      sessionId: "s-1",
    });
    sessions.push(session);
    return { fake, session };
  }

  const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
  const serverNames = (request: unknown): unknown[] =>
    (plain(request).mcpServers as { name: string }[]).map((server) => server.name);

  test("AC-8: session/new names the MCP server with the session's name", async () => {
    const { fake } = await open([lookup]);
    expect(serverNames(fake.callsTo("session/new")[0])).toEqual([NAME]);
  });

  test("AC-9: session/new pre-approves the tool under that name", async () => {
    const { fake } = await open([lookup]);
    expect(plain(fake.callsTo("session/new")[0])._meta).toMatchObject({
      claudeCode: { options: { allowedTools: ["mcp__nax-0badc0de__lookup"] } },
    });
  });

  test("AC-10, AC-11: the reconnect names the same server and no second name is drawn", async () => {
    const { fake, session } = await open([lookup]);
    await driveTurn(session, "one");
    fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await driveTurn(session, "two");
    const resumed = [...fake.callsTo("session/resume"), ...fake.callsTo("session/load")];
    expect(resumed).toHaveLength(1);
    expect(serverNames(resumed[0])).toEqual([NAME]);
    expect(plain(resumed[0])._meta).toMatchObject({
      claudeCode: { options: { allowedTools: ["mcp__nax-0badc0de__lookup"] } },
    });
    expect(drawn).toBe(1);
  });

  test("AC-12: a session with no tools never draws a name", async () => {
    await open([]);
    expect(drawn).toBe(0);
  });
});

describe("toolHostFor and the options it passes", () => {
  const realCreate = _acpBackendDeps.createToolHost;
  const seen: (ToolHostOptions | undefined)[] = [];
  const stub: ToolHost = {
    token: "stub-token",
    serverName: NAME,
    start: async () => {
      throw new Error("the stub host is never started");
    },
    drain: async () => {},
    stop: async () => {},
  };

  beforeEach(() => {
    _acpBackendDeps.createToolHost = (_calls, _token, options) => {
      seen.push(options);
      return stub;
    };
  });

  afterEach(() => {
    _acpBackendDeps.createToolHost = realCreate;
    seen.splice(0);
  });

  const router = () => createInboundRouter(async (request) => rejectLocally(request));

  test("AC-13: serverName joins the host options next to the instructions", () => {
    const ctx = openContext("/repo", { providerInstructions: "X", tools: [lookup] });
    toolHostFor(ctx, router(), [], "token-1", NAME);
    expect(seen).toEqual([{ instructions: "X", serverName: NAME }]);
  });

  test("AC-21: no serverName and no instructions leaves the options undefined", () => {
    toolHostFor(openContext("/repo", { tools: [lookup] }), router(), [], "token-1");
    expect(seen).toEqual([undefined]);
  });
});

describe("parseToolHostToolName", () => {
  test("AC-14: the tool name after a session-named server", () => {
    expect(parseToolHostToolName("mcp__nax-0badc0de__codegraph__search_graph")).toBe("codegraph__search_graph");
  });

  test.each([
    ["AC-15: the bare prefix", "mcp__nax__lookup"],
    ["AC-16: uppercase hex", "mcp__nax-0BADC0DE__lookup"],
    ["AC-17: an empty tool name", "mcp__nax-0badc0de__"],
    ["AC-18: a non-MCP tool", "Bash"],
  ])("%s is undefined", (_label, name) => {
    expect(parseToolHostToolName(name)).toBeUndefined();
  });

  test("AC-19: exported from the ./client entry", () => {
    expect(parseFromEntry("mcp__nax-0badc0de__lookup")).toBe("lookup");
  });

  test("AC-20: TOOL_HOST_SERVER_NAME stays nax", () => {
    expect(prefixFromEntry).toBe("nax");
  });
});
