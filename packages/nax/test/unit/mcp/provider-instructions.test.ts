import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type CodingTool,
  createMemoryTranscriptStore,
  renderProviderInstructions,
  type ToolProvider,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeNaxConfig, makeTempDir, withInfoSpy, withWarnSpy } from "@test/helpers";
import { createAskPort } from "@/agents/acp/ask-port";
import { openContext } from "@/agents/acp/open-context";
import { createTurnSlot } from "@/agents/acp/turn-slot";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { McpServerSchema } from "@/config/schemas-mcp";
import { _mcpClientDeps, connectMcpServer } from "@/mcp/client";
import { schemaHash } from "@/mcp/lock";
import { createMcpPool, type McpPool } from "@/mcp/pool";
import { createMcpProviders } from "@/mcp/provider";
import { openSessionExtras } from "@/session/open-session-extras";

const original = { ..._mcpClientDeps };
let root = "";
afterEach(() => {
  Object.assign(_mcpClientDeps, original);
  if (root) cleanupTempDir(root);
  root = "";
});
const schema = { type: "object" };
const tools = ["list_projects", "search_graph"].map((name) => ({ name, description: name, inputSchema: schema }));
const server = McpServerSchema.parse({ command: "fake", stages: ["*"] });
function shared(instructions = "S") {
  return {
    kind: "stdio" as const,
    pid: null,
    tools,
    instructions,
    call: async () => ({ text: "ok", isError: false, bytesBeforeCap: 2 }),
    onClose: () => {},
    close: async () => {},
  };
}
function provider(poolText?: string, configText?: string, allowedTools?: string[], omitPoolMethod = false) {
  const pool: McpPool = {
    listTools: async () => tools,
    call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
    events: () => [],
    close: async () => {},
    ...(omitPoolMethod ? {} : { instructions: async () => poolText }),
  };
  const [result] = createMcpProviders({
    config: { servers: { memory: { ...server, instructions: configText, allowedTools } } },
    pool,
    projectRoot: "/repo",
    readLock: async () => ({
      version: 1,
      servers: { memory: Object.fromEntries(tools.map((t) => [t.name, schemaHash(schema)])) },
    }),
  });
  assertDefined(result, "provider");
  return result;
}

describe("MCP instructions config and connections", () => {
  test("AC-1 keeps instructions", () => {
    expect(McpServerSchema.parse({ command: "x", instructions: "Pass {workdir} as project" }).instructions).toBe(
      "Pass {workdir} as project",
    );
  });
  test("AC-2 rejects typo", () => {
    expect(() => McpServerSchema.parse({ command: "x", instruction: "typo" })).toThrow();
  });
  test("AC-3 rejects empty text", () => {
    expect(() => McpServerSchema.parse({ command: "x", instructions: "" })).toThrow();
  });
  test("AC-4 forwards shared connection instructions", async () => {
    _mcpClientDeps.connect = async () => shared();
    const connection = await connectMcpServer({
      serverId: "memory",
      workdir: "/w",
      command: "x",
      args: [],
      env: {},
      connectTimeoutMs: 100,
    });
    expect(connection.instructions).toBe("S");
    await connection.close();
  });
  test("AC-5 reuses the listed pooled connection", async () => {
    const connect = mock(async () => shared());
    _mcpClientDeps.connect = connect;
    const pool = createMcpPool({ servers: { memory: server } });
    try {
      await pool.listTools("memory", "/w");
      assertDefined(pool.instructions, "pool instructions method");
      expect(await pool.instructions("memory", "/w")).toBe("S");
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
    }
  });
  test("AC-6 failed connection has no instructions", async () => {
    _mcpClientDeps.connect = async () => {
      throw new Error("offline");
    };
    const pool = createMcpPool({ servers: { memory: server }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
    try {
      assertDefined(pool.instructions, "pool instructions method");
      expect(await pool.instructions("memory", "/w")).toBeUndefined();
    } finally {
      await pool.close();
    }
  });
});

describe("MCP provider instructions", () => {
  test.each([
    ["AC-7", "Server text", "Pass {workdir} as project", "/repo/wt", "Server text\n\nPass /repo/wt as project"],
    ["AC-8", "Server text", undefined, "/w", "Server text"],
    ["AC-9", undefined, "Hint", "/w", "Hint"],
    ["AC-10", undefined, undefined, "/w", undefined],
    ["config-only substitution", "Keep {workdir}", "{workdir} and {workdir}", "/w", "Keep {workdir}\n\n/w and /w"],
  ])("%s", async (_ac, pool, config, workdir, expected) => {
    const p = provider(pool, config);
    assertDefined(p.instructions, "provider instructions method");
    assertDefined(workdir, "workdir");
    expect(await p.instructions(workdir)).toBe(expected);
  });
  test("legacy pool without method supports config text", async () => {
    const p = provider(undefined, "Hint", undefined, true);
    assertDefined(p.instructions, "provider instructions method");
    expect(await p.instructions("/w")).toBe("Hint");
  });
  test("AC-11 warns on first listing", async () => {
    await withWarnSpy(async (warn) => {
      const p = provider("Call list_projects before initial use", undefined, ["search_graph"]);
      await p.tools("/w");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).toContain("list_projects");
    });
  });
  test("AC-12 warns once across workdirs", async () => {
    await withWarnSpy(async (warn) => {
      const p = provider("Call list_projects before initial use", undefined, ["search_graph"]);
      await p.tools("/w");
      await p.tools("/other");
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
  test.each(["Call search_graph", "Call my_list_projects_helper"])(
    "AC-13 no warning for allowed tools or partial names: %s",
    async (text) => {
      await withWarnSpy(async (warn) => {
        await provider(text, undefined, ["search_graph"]).tools("/w");
        expect(warn).not.toHaveBeenCalled();
      });
    },
  );
});

function stubProvider(text?: string): ToolProvider {
  return {
    id: "memory",
    kind: "discovered",
    stages: ["*"],
    instructions: async () => text,
    tools: async () => [
      { localName: "search_graph", description: "Search", inputSchema: schema, run: async () => ({ content: "ok" }) },
    ],
  };
}
async function support(text?: string) {
  root = makeTempDir();
  return resolveCodingToolSupport({
    config: makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
    codingToolRoot: root,
    pipelineStage: "run",
    providers: [stubProvider(text)],
  });
}
test("AC-14 renders provider instructions into coding support", async () => {
  const result = await support("Use the repo root");
  expect(result?.providerInstructions).toBe(
    renderProviderInstructions([{ providerId: "memory", text: "Use the repo root" }]),
  );
});
test("AC-15 logs attachment ids and rendered length", async () => {
  await withInfoSpy(async (info) => {
    const result = await support("Use the repo root");
    const calls = info.mock.calls.filter((c) => c[0] === "mcp");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("memory");
    expect(JSON.stringify(calls[0])).toContain(String(result?.providerInstructions?.length));
  });
});
test("AC-16 absent instructions key", async () => {
  const result = await support();
  expect(result).toBeDefined();
  expect(result).not.toHaveProperty("providerInstructions");
});
test("AC-17 extras forward instructions", () => {
  expect(openSessionExtras({ providerInstructions: "X" }, undefined)).toHaveProperty("providerInstructions", "X");
});
test("AC-18 extras omit absent key", () => {
  expect(openSessionExtras({}, undefined)).not.toHaveProperty("providerInstructions");
});

const codingTool: CodingTool = {
  scope: { pathFields: [] },
  name: "memory__search_graph",
  description: "Search",
  inputSchema: schema,
  run: async () => ({ content: "ok" }),
};
test.each([
  ["AC-20", "claude", true],
  ["AC-21", "codex", false],
] as const)("%s ACP instruction delivery", (_ac, agent, delivered) => {
  const slot = createTurnSlot();
  const context = openContext({
    name: "s",
    agent,
    opts: {
      agentName: agent,
      workdir: "/w",
      modelDef: { provider: "anthropic", model: "sonnet" },
      timeoutSeconds: 30,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      providerInstructions: "X",
      providerTools: [codingTool],
    },
    store: createMemoryTranscriptStore(),
    resume: undefined,
    asks: createAskPort(slot),
    slot,
    openSignal: new AbortController().signal,
  });
  expect(context.tools).toHaveLength(delivered ? 1 : 0);
  if (delivered) expect(context.providerInstructions).toBe("X");
  else expect(context).not.toHaveProperty("providerInstructions");
});
