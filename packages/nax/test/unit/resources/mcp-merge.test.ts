// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MCP `${VAR}` catalog syntax, not JS interpolation.
import { describe, expect, test } from "bun:test";
import { MCP_DEFAULT_TIMEOUT_MS, MCP_SERVER_ID_RE, McpConfigSchema } from "@/config";
import {
  buildResourceCatalog,
  type McpServerResource,
  type McpServerScope,
  type McpServerSpec,
  mergeCatalogMcpServers,
  type ResourceOrigin,
  type ResourcePackage,
} from "@/resources";

const PROJECT: ResourceOrigin = { kind: "claude-project" };

function entry(
  name: string,
  server: McpServerSpec,
  options: { scope?: McpServerScope; origin?: ResourceOrigin; path?: string } = {},
): McpServerResource {
  return {
    kind: "mcp",
    name,
    transport: server.transport,
    scope: options.scope ?? "project",
    server,
    path: options.path ?? "/repo/.mcp.json",
    origin: options.origin ?? PROJECT,
  };
}

function stdio(command: string, args: string[] = [], env: Record<string, string> = {}): McpServerSpec {
  return { transport: "stdio", command, args, env };
}

function pkg(
  id: string,
  mcpServers: McpServerResource[],
  options: { origin?: ResourceOrigin; root?: string } = {},
): ResourcePackage {
  return {
    id,
    origin: options.origin ?? PROJECT,
    root: options.root ?? "/repo",
    skills: [],
    commands: [],
    agents: [],
    mcpServers,
    hooks: [],
    diagnostics: [],
  };
}

function plugin(name: string): ResourceOrigin {
  return { kind: "claude-plugin", plugin: name, marketplace: "m" };
}

const noEnv = {};

describe("mergeCatalogMcpServers — stdio entry from the catalog", () => {
  const catalog = buildResourceCatalog([
    pkg("claude-project", [entry("ctx", stdio("npx", ["${ROOT}/s"], { ROOT: "/r" }))]),
  ]);
  const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: { ROOT: "/r" } });

  test("expands args from the environment", () => {
    expect(result.config.servers.ctx?.args).toEqual(["/r/s"]);
  });
  test("attaches to every stage", () => {
    expect(result.config.servers.ctx?.stages).toEqual(["*"]);
  });
  test("uses the default timeout", () => {
    expect(result.config.servers.ctx?.timeoutMs).toBe(MCP_DEFAULT_TIMEOUT_MS);
  });
  test("records the project source", () => {
    expect(result.sources.get("ctx")).toEqual({ source: "project" });
  });
  test("is enabled with empty headers", () => {
    expect(result.config.servers.ctx?.enabled).toBe(true);
    expect(result.config.servers.ctx?.headers).toEqual({});
  });
  test("keeps the command", () => {
    const only = buildResourceCatalog([pkg("claude-project", [entry("ctx", stdio("npx"))])]);
    expect(mergeCatalogMcpServers({ mcp: undefined, catalog: only, env: noEnv }).config.servers.ctx?.command).toBe(
      "npx",
    );
  });
});

describe("mergeCatalogMcpServers — configured servers", () => {
  const configured = (command: string, args: string[] = []) => ({
    servers: {
      ctx: { command, args, env: {}, stages: ["run" as const], timeoutMs: 5, enabled: true, headers: {} },
    },
  });

  test("a configured server wins over a catalog server with the same id and warns", () => {
    const catalog = buildResourceCatalog([pkg("claude-project", [entry("ctx", stdio("theirs"))])]);
    const result = mergeCatalogMcpServers({ mcp: configured("mine"), catalog, env: noEnv });
    expect(result.config.servers.ctx?.command).toBe("mine");
    expect(result.sources.get("ctx")).toEqual({ source: "config" });
    const warns = result.diagnostics.filter((d) => d.severity === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("mcp server ctx");
    expect(warns[0]?.message).toContain("is shadowed by config");
    expect(warns[0]?.path).toBe("/repo/.mcp.json");
    expect(warns[0]?.origin).toEqual(PROJECT);
  });

  test("configured args are not expanded", () => {
    const result = mergeCatalogMcpServers({
      mcp: configured("mine", ["${HOME}/x"]),
      catalog: buildResourceCatalog([]),
      env: { HOME: "/h" },
    });
    expect(result.config.servers.ctx?.args).toEqual(["${HOME}/x"]);
  });
});

describe("mergeCatalogMcpServers — precedence", () => {
  test("a local entry beats a project entry in the same package", () => {
    const catalog = buildResourceCatalog([
      pkg("claude-project", [
        entry("ctx", stdio("local-cmd"), { scope: "local" }),
        entry("ctx", stdio("project-cmd"), { scope: "project" }),
      ]),
    ]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers.ctx?.command).toBe("local-cmd");
    expect(result.sources.get("ctx")).toEqual({ source: "local" });
    expect(result.diagnostics[0]?.message).toContain("is shadowed by local");
  });

  test("a user entry is shadowed by a project entry", () => {
    const user: ResourceOrigin = { kind: "claude-user" };
    const catalog = buildResourceCatalog([
      pkg("claude-project", [entry("ctx", stdio("p"))]),
      pkg("claude-user", [entry("ctx", stdio("u"), { scope: "user", origin: user })], { origin: user }),
    ]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers.ctx?.command).toBe("p");
    expect(result.diagnostics[0]?.message).toBe(
      "[resources] mcp server ctx from /repo/.mcp.json is shadowed by project",
    );
  });
});

describe("mergeCatalogMcpServers — claude-plugin entries", () => {
  const origin = plugin("chrome");
  const pluginPkg = pkg(
    "chrome@m",
    [entry("server", stdio("${CLAUDE_PLUGIN_ROOT}/bin/run"), { scope: "plugin", origin })],
    { origin, root: "/p" },
  );
  const catalog = buildResourceCatalog([pluginPkg]);

  test("prefixes the id with the plugin name and expands CLAUDE_PLUGIN_ROOT", () => {
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers["chrome-server"]?.command).toBe("/p/bin/run");
    expect(result.sources.get("chrome-server")).toEqual({ source: "plugin", plugin: "chrome" });
  });

  test("the package root overrides CLAUDE_PLUGIN_ROOT in the environment", () => {
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: { CLAUDE_PLUGIN_ROOT: "/elsewhere" } });
    expect(result.config.servers["chrome-server"]?.command).toBe("/p/bin/run");
  });

  test("two plugin entries mapping to one id: the first plugin wins", () => {
    const a = plugin("a");
    const ab = plugin("a-b");
    const two = buildResourceCatalog([
      pkg("a@m", [entry("b-c", stdio("first"), { scope: "plugin", origin: a })], { origin: a }),
      pkg("a-b@m", [entry("c", stdio("second"), { scope: "plugin", origin: ab })], { origin: ab }),
    ]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog: two, env: noEnv });
    expect(result.config.servers["a-b-c"]?.command).toBe("first");
    const warn = result.diagnostics.find((d) => d.severity === "warn");
    expect(warn?.message).toContain("is shadowed by plugin a");
  });

  test("a non-plugin entry does not get CLAUDE_PLUGIN_ROOT", () => {
    const only = buildResourceCatalog([pkg("claude-project", [entry("x", stdio("${CLAUDE_PLUGIN_ROOT}/b"))])]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog: only, env: noEnv });
    expect(result.config.servers.x).toBeUndefined();
    expect(result.diagnostics[0]?.message).toBe("[resources] mcp server x: ${CLAUDE_PLUGIN_ROOT} is not set");
  });
});

describe("mergeCatalogMcpServers — http entries", () => {
  const http = entry("r", { transport: "http", url: "https://h/${P}", headers: { A: "${T}" } });
  const catalog = buildResourceCatalog([pkg("claude-project", [http])]);
  const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: { P: "mcp", T: "tok" } });

  test("expands url and header values", () => {
    expect(result.config.servers.r?.url).toBe("https://h/mcp");
    expect(result.config.servers.r?.headers?.A).toBe("tok");
  });
  test("fills args and env empty and passes the config schema", () => {
    expect(result.config.servers.r?.args).toEqual([]);
    expect(result.config.servers.r?.env).toEqual({});
    expect(McpConfigSchema.safeParse({ servers: { r: result.config.servers.r } }).success).toBe(true);
  });
  test("does not expand header keys", () => {
    const keyed = entry("k", { transport: "http", url: "https://h", headers: { "${T}": "v" } });
    const out = mergeCatalogMcpServers({
      mcp: undefined,
      catalog: buildResourceCatalog([pkg("claude-project", [keyed])]),
      env: { T: "tok" },
    });
    expect(out.config.servers.k?.headers).toEqual({ "${T}": "v" });
  });
});

describe("mergeCatalogMcpServers — dropped entries", () => {
  test("an unset variable in an env value drops the entry with an error", () => {
    const catalog = buildResourceCatalog([pkg("claude-project", [entry("e", stdio("x", [], { K: "${NOPE}" }))])]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers.e).toBeUndefined();
    const error = result.diagnostics.find((d) => d.severity === "error");
    expect(error?.message).toContain("${NOPE} is not set");
    expect(error?.message).toBe("[resources] mcp server e: ${NOPE} is not set");
  });

  test("an sse entry is dropped with a warn", () => {
    const sse = entry("s", { transport: "sse", url: "https://h/sse", headers: {} });
    const catalog = buildResourceCatalog([pkg("claude-project", [sse])]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers.s).toBeUndefined();
    const warn = result.diagnostics.find((d) => d.severity === "warn");
    expect(warn?.message).toContain("mcp server s: transport sse is not supported");
  });

  test("a name with no usable id is dropped with an error", () => {
    const catalog = buildResourceCatalog([pkg("claude-project", [entry("!!!", stdio("x"))])]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(Object.keys(result.config.servers)).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.message).toBe(
      "[resources] mcp server name !!! in /repo/.mcp.json yields no usable id",
    );
  });

  test("a dropped entry does not claim its id", () => {
    const catalog = buildResourceCatalog([
      pkg("claude-project", [entry("dup", stdio("${NOPE}"), { scope: "local" }), entry("dup", stdio("ok"))]),
    ]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    expect(result.config.servers.dup?.command).toBe("ok");
  });
});

describe("mergeCatalogMcpServers — shape", () => {
  test("no configuration and an empty catalog yield no servers", () => {
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog: buildResourceCatalog([]), env: noEnv });
    expect(result.config.servers).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  test("normalizes the entry name into the server key", () => {
    const catalog = buildResourceCatalog([pkg("claude-project", [entry("Codebase Memory.MCP", stdio("x"))])]);
    const result = mergeCatalogMcpServers({ mcp: undefined, catalog, env: noEnv });
    const keys = Object.keys(result.config.servers);
    expect(keys).toEqual(["codebase-memory-mcp"]);
    expect(keys[0]).toMatch(MCP_SERVER_ID_RE);
  });
});
