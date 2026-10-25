import { afterEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools } from "@nathapp/nax-agent";
import type { McpConnection } from "@nathapp/nax-agent/mcp";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { _chatMcpDeps, CHAT_MCP_RETRY, createChatMcp } from "@/chat";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps, type McpLockFile, type McpPool, schemaHash } from "@/mcp";
import { buildResourceCatalog, type McpServerResource, type ResourcePackage } from "@/resources";

const originals = { ..._chatMcpDeps };
const originalClient = { ..._mcpClientDeps };
afterEach(() => {
  Object.assign(_chatMcpDeps, originals);
  Object.assign(_mcpClientDeps, originalClient);
});

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: "docs-mcp", args: [], env: {}, stages: ["run"], timeoutMs: 1000, enabled: true, ...overrides };
}

function fakePool() {
  const close = mock(async () => {});
  const pool: McpPool = {
    listTools: async () => [],
    call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
    events: () => [],
    close,
  };
  return { pool, close };
}

function install() {
  const { pool, close } = fakePool();
  const createMcpPool = mock((_opts: Parameters<typeof originals.createMcpPool>[0]) => pool);
  _chatMcpDeps.createMcpPool = createMcpPool;
  _chatMcpDeps.readLock = async () => undefined;
  return { pool, close, createMcpPool };
}

function input(servers: Record<string, McpServerConfig>, catalog = buildResourceCatalog([])) {
  return {
    config: makeNaxConfig({ mcp: { servers } }),
    catalog,
    repoRoot: "/r",
    env: {},
  };
}

function projectCatalog(name: string) {
  const entry: McpServerResource = {
    kind: "mcp",
    name,
    transport: "stdio",
    scope: "project",
    server: { transport: "stdio", command: "npx", args: [], env: {} },
    path: "/r/.mcp.json",
    origin: { kind: "claude-project" },
  };
  const pkg: ResourcePackage = {
    id: "claude-project",
    origin: { kind: "claude-project" },
    root: "/r",
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [entry],
    hooks: [],
    diagnostics: [],
  };
  return buildResourceCatalog([pkg]);
}

describe("createChatMcp", () => {
  test("AC-1 builds the pool with stages [*] for a run-only configured server", async () => {
    const f = install();
    await createChatMcp(input({ docs: server({ stages: ["run"] }) }));
    expect(f.createMcpPool).toHaveBeenCalledTimes(1);
    expect(f.createMcpPool.mock.calls[0]?.[0].servers.docs?.stages).toEqual(["*"]);
  });
  test("AC-2 creates the pool with CHAT_MCP_RETRY", async () => {
    const f = install();
    await createChatMcp(input({ docs: server() }));
    expect(f.createMcpPool.mock.calls[0]?.[0].retry).toEqual(CHAT_MCP_RETRY);
  });
  test("AC-3 CHAT_MCP_RETRY allows one attempt", () => {
    expect(CHAT_MCP_RETRY.maxAttempts).toBe(1);
  });
  test("AC-4 a disabled server yields no provider", async () => {
    install();
    const chat = await createChatMcp(input({ off: server({ enabled: false }) }));
    expect(chat.providers.map((p) => p.id)).not.toContain("off");
  });
  test("AC-5/6 one enabled server yields one discovered provider", async () => {
    install();
    const chat = await createChatMcp(input({ docs: server() }));
    expect(chat.providers.map((p) => p.id)).toEqual(["docs"]);
    expect(chat.providers[0]?.kind).toBe("discovered");
  });
  test("AC-7/8 no enabled server yields no providers and builds no pool", async () => {
    const f = install();
    const chat = await createChatMcp(input({ off: server({ enabled: false }) }));
    expect(chat.providers).toEqual([]);
    expect(chat.state.events()).toEqual([]);
    expect(chat.state.servers).toEqual([]);
    expect(f.createMcpPool).not.toHaveBeenCalled();
    await chat.close();
    expect(f.close).not.toHaveBeenCalled();
  });
  test("AC-9 close closes the pool once", async () => {
    const f = install();
    const chat = await createChatMcp(input({ docs: server() }));
    await chat.close();
    await chat.close();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  test("AC-10/11 a catalog server absent from the lock is not attached or pooled but has a row", async () => {
    const f = install();
    _chatMcpDeps.readLock = async () => ({ version: 1, servers: {} });
    const chat = await createChatMcp(input({}, projectCatalog("ctx")));
    expect(chat.providers.map((p) => p.id)).not.toContain("ctx");
    expect(f.createMcpPool).not.toHaveBeenCalled();
    expect(chat.state.servers).toEqual([{ id: "ctx", source: "project", transport: "stdio", locked: false }]);
  });
  test("a catalog server the lock lists is attached and its row is locked", async () => {
    const f = install();
    _chatMcpDeps.readLock = async () => ({ version: 1, servers: { ctx: {} } });
    const chat = await createChatMcp(input({}, projectCatalog("ctx")));
    expect(chat.providers.map((p) => p.id)).toEqual(["ctx"]);
    expect(Object.keys(f.createMcpPool.mock.calls[0]?.[0].servers ?? {})).toEqual(["ctx"]);
    expect(chat.state.servers).toEqual([{ id: "ctx", source: "project", transport: "stdio", locked: true }]);
  });
  test("AC-12 a configured server is attached when no lock exists", async () => {
    install();
    _chatMcpDeps.readLock = async () => undefined;
    const chat = await createChatMcp(input({ docs: server() }));
    expect(chat.providers.map((p) => p.id)).toEqual(["docs"]);
    expect(chat.state.servers).toEqual([{ id: "docs", source: "config", transport: "stdio", locked: true }]);
  });
  test("rows report http transport for a url server", async () => {
    install();
    const chat = await createChatMcp(input({ web: server({ command: undefined, url: "https://x.test/mcp" }) }));
    expect(chat.state.servers[0]?.transport).toBe("http");
  });
  test("AC-13/14 nax-skills is reserved: not attached, error diagnostic", async () => {
    const f = install();
    const chat = await createChatMcp(input({ "nax-skills": server() }));
    expect(chat.providers.map((p) => p.id)).not.toContain("nax-skills");
    expect(f.createMcpPool).not.toHaveBeenCalled();
    expect(chat.state.servers).toEqual([]);
    const reserved = chat.state.diagnostics.find((d) => d.message.includes("mcp server id nax-skills is reserved"));
    expect(reserved?.severity).toBe("error");
    expect(reserved?.message).toBe("[resources] mcp server id nax-skills is reserved");
  });
  test("diagnostics: merge diagnostics, then only .mcp.json and .claude.json catalog diagnostics", async () => {
    install();
    const origin = { kind: "claude-project" } as const;
    const base = projectCatalog("ctx");
    const pkg = base.packages[0];
    assertDefined(pkg, "pkg");
    const catalog = buildResourceCatalog([
      {
        ...pkg,
        mcpServers: [],
        diagnostics: [
          { severity: "warn", path: "/r/.mcp.json", message: "a", origin },
          { severity: "warn", path: "/r/skills/x/SKILL.md", message: "b", origin },
          { severity: "error", path: "/h/.claude.json", message: "c", origin },
        ],
      },
    ]);
    const chat = await createChatMcp(input({}, catalog));
    expect(chat.state.diagnostics.map((d) => d.message)).toEqual(["a", "c"]);
  });
  test("withheld() records each withheld tool once across repeated tools() calls", async () => {
    const f = install();
    f.pool.listTools = async () => [{ name: "t", description: "d", inputSchema: { type: "object" } }];
    _chatMcpDeps.readLock = async () => ({ version: 1, servers: { docs: {} } });
    const chat = await createChatMcp(input({ docs: server() }));
    const provider = chat.providers[0];
    assertDefined(provider, "provider");
    await provider.tools("/w");
    await provider.tools("/w");
    expect(chat.state.withheld()).toHaveLength(1);
    expect(chat.state.withheld()[0]).toMatchObject({ serverId: "docs", name: "t", reason: "absent-from-lock" });
  });
  test("US-008 AC-1/2 withheld() holds the entry passed to onWithheld once per server and tool", async () => {
    const f = install();
    const createMcpProviders = mock((_opts: Parameters<typeof originals.createMcpProviders>[0]) => []);
    _chatMcpDeps.createMcpProviders = createMcpProviders;
    const chat = await createChatMcp(input({ docs: server() }));
    const onWithheld = createMcpProviders.mock.calls[0]?.[0].onWithheld;
    assertDefined(onWithheld, "onWithheld");
    expect(createMcpProviders.mock.calls[0]?.[0].pool).toBe(f.pool);
    const entry = { serverId: "docs", name: "t", reason: "absent-from-lock", lockSource: "project" } as const;
    onWithheld(entry);
    expect(chat.state.withheld()).toEqual([entry]);
    onWithheld({ ...entry });
    expect(chat.state.withheld()).toHaveLength(1);
    onWithheld({ ...entry, name: "u" });
    expect(chat.state.withheld()).toHaveLength(2);
  });
  test("US-008 AC-4 diagnostics include the merge diagnostic for a shadowed server", async () => {
    install();
    const chat = await createChatMcp(input({ ctx: server() }, projectCatalog("ctx")));
    expect(chat.state.diagnostics.map((d) => d.message)).toContain(
      "[resources] mcp server ctx from /r/.mcp.json is shadowed by config",
    );
  });
  test("US-008 AC-5 a configured url server has an http config row", async () => {
    install();
    const chat = await createChatMcp(input({ remote: server({ command: undefined, url: "https://x.test/mcp" }) }));
    expect(chat.state.servers).toEqual([{ id: "remote", source: "config", transport: "http", locked: true }]);
  });
  test("US-008 AC-6 a configured command server has a stdio row", async () => {
    install();
    const chat = await createChatMcp(input({ docs: server() }));
    expect(chat.state.servers[0]?.transport).toBe("stdio");
  });
  test("US-008 AC-7 a plugin catalog server row carries the plugin name", async () => {
    install();
    _chatMcpDeps.readLock = async () => ({ version: 1, servers: { "chrome-server": {} } });
    const origin = { kind: "claude-plugin", plugin: "chrome", marketplace: "m" } as const;
    const entry: McpServerResource = {
      kind: "mcp",
      name: "server",
      transport: "stdio",
      scope: "plugin",
      server: { transport: "stdio", command: "run", args: [], env: {} },
      path: "/p/.mcp.json",
      origin,
    };
    const catalog = buildResourceCatalog([
      {
        id: "chrome@m",
        origin,
        root: "/p",
        skills: [],
        commands: [],
        agents: [],
        mcpServers: [entry],
        hooks: [],
        diagnostics: [],
      },
    ]);
    const chat = await createChatMcp(input({}, catalog));
    expect(chat.state.servers[0]).toMatchObject({ id: "chrome-server", source: "plugin", plugin: "chrome" });
  });
  test("US-008 AC-8 state.events() returns the events of the pool from createMcpPool", async () => {
    const f = install();
    const events: ReturnType<McpPool["events"]> = [{ kind: "closed", serverId: "docs", workdir: "/w", at: "t" }];
    f.pool.events = () => events;
    const chat = await createChatMcp(input({ docs: server() }));
    expect(chat.state.events()).toEqual(events);
  });
  test("state.events() reads the pool's events live", async () => {
    const f = install();
    const events: ReturnType<McpPool["events"]> = [];
    f.pool.events = () => events;
    const chat = await createChatMcp(input({ docs: server() }));
    expect(chat.state.events()).toBe(events);
  });
});

describe("createChatMcp connection failure", () => {
  test("AC-24 session open resolves without a server that fails to connect", async () => {
    const schema = { type: "object" };
    const lock: McpLockFile = { version: 1, servers: { good: { t: schemaHash(schema) }, dead: {} } };
    _chatMcpDeps.readLock = async () => lock;
    const connection: McpConnection = {
      kind: "stdio",
      pid: 7,
      tools: [{ name: "t", description: "d", inputSchema: schema }],
      call: async () => ({ text: "ok", isError: false, bytesBeforeCap: 2 }),
      onClose: () => {},
      close: async () => {},
    };
    Object.assign(_mcpClientDeps, {
      connect: async (config: { command?: string }): Promise<McpConnection> => {
        if (config.command === "dead-mcp") throw new Error("spawn ENOENT");
        return connection;
      },
    });
    const chat = await createChatMcp(
      input({ dead: server({ command: "dead-mcp", stages: ["*"] }), good: server({ command: "good-mcp" }) }),
    );
    try {
      const resolved = await resolveProviderTools(chat.providers, "session", "/w");
      expect(resolved.tools.map((tool) => tool.name)).toEqual(["good__t"]);
      expect(resolved.failures).toEqual([]);
      expect(chat.state.events().map((e) => `${e.serverId}:${e.kind}`)).toEqual([
        "dead:connect-failed",
        "good:connected",
      ]);
    } finally {
      await chat.close();
    }
  });
});
