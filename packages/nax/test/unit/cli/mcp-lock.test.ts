import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { _mcpLockCommandDeps, runMcpLockCommand } from "@/cli/mcp";
import type { McpServerConfig } from "@/config";
import { type createMcpPool, type McpPool, type McpToolDescriptor, schemaHash } from "@/mcp";
import { loadResourceCatalog } from "@/resources";

const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0 };
const SCHEMA = { type: "object", properties: { q: { type: "string" } } };

let projectDir: string;
let claudeDir: string;
let globalDir: string;
let previousGlobalDir: string | undefined;
let requested: Record<string, McpServerConfig>[];
let listed: string[];
let toolsByServer: Record<string, McpToolDescriptor[]>;

function fakePool(servers: Readonly<Record<string, McpServerConfig>>): McpPool {
  requested.push({ ...servers });
  return {
    listTools: async (id) => {
      listed.push(id);
      return toolsByServer[id] ?? [];
    },
    call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
    events: () => [],
    close: async () => {},
  };
}

const configured = (command: string): McpServerConfig => ({
  command,
  args: [],
  env: {},
  headers: {},
  stages: ["run"],
  timeoutMs: 5,
  enabled: true,
});

function writeConfig(config: Record<string, unknown> = {}): void {
  writeFileSync(join(projectDir, ".nax", "config.json"), JSON.stringify({ name: "probe", ...config }));
}

function writeProjectMcpJson(): void {
  writeFileSync(
    join(projectDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { ctx: { command: "npx", args: ["s"] } } }),
  );
}

async function lock(opts?: { global?: boolean }): Promise<void> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMcpLockCommand(projectDir, { ...opts, retry: NO_RETRY });
  } finally {
    log.mockRestore();
  }
}

const readLock = async (
  path: string,
): Promise<{ servers: Record<string, Record<string, string>>; readOnly?: unknown }> =>
  JSON.parse(await Bun.file(path).text());
const projectLock = (): string => join(projectDir, ".nax", "mcp-lock.json");

describe("runMcpLockCommand with catalog servers", () => {
  withDepsRestore(_mcpLockCommandDeps);

  beforeEach(() => {
    projectDir = realpathSync(makeTempDir("nax-mcp-lock-project-"));
    claudeDir = realpathSync(makeTempDir("nax-mcp-lock-claude-"));
    globalDir = realpathSync(makeTempDir("nax-mcp-lock-global-"));
    mkdirSync(join(projectDir, ".nax"), { recursive: true });
    previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    requested = [];
    listed = [];
    toolsByServer = {};
    writeConfig();
    writeProjectMcpJson();
    _mcpLockCommandDeps.env = { CLAUDE_CONFIG_DIR: claudeDir };
    _mcpLockCommandDeps.createMcpPool = ((opts: { servers: Readonly<Record<string, McpServerConfig>> }) =>
      fakePool(opts.servers)) as typeof createMcpPool;
  });

  afterEach(() => {
    if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
    cleanupTempDir(projectDir);
    cleanupTempDir(claudeDir);
    cleanupTempDir(globalDir);
  });

  test("AC-7 pins a .mcp.json server's tools by input-schema hash in the project lock", async () => {
    toolsByServer.ctx = [{ name: "t", description: "d", inputSchema: SCHEMA }];

    await lock();

    expect((await readLock(projectLock())).servers.ctx).toEqual({ t: schemaHash(SCHEMA) });
  });

  test("AC-8 records readOnly[id] as the sorted names of read-only-hinted tools", async () => {
    toolsByServer.ctx = [
      { name: "w", description: "d", inputSchema: SCHEMA },
      { name: "r", description: "d", inputSchema: SCHEMA, readOnly: true },
    ];

    await lock();

    expect((await readLock(projectLock())).readOnly).toEqual({ ctx: ["r"] });
  });

  test("AC-8 omits readOnly when no listed tool is hinted read-only", async () => {
    toolsByServer.ctx = [{ name: "w", description: "d", inputSchema: SCHEMA }];

    await lock();

    expect((await readLock(projectLock())).readOnly).toBeUndefined();
  });

  test("AC-10 writes the catalog server into the global lock under --global", async () => {
    toolsByServer.ctx = [{ name: "t", description: "d", inputSchema: SCHEMA }];

    await lock({ global: true });

    expect((await readLock(join(globalDir, "mcp-lock.json"))).servers.ctx).toBeDefined();
  });

  test("AC-11 lists tools through the pool for both configured and catalog servers", async () => {
    writeConfig({ mcp: { servers: { a: { command: "bun", stages: ["run"] } } } });

    await lock();

    expect([...listed].sort()).toEqual(["a", "ctx"]);
    expect(Object.keys(requested[0] ?? {}).sort()).toEqual(["a", "ctx"]);
  });

  test("AC-16 sends only configured servers to the pool when resources.claudeCode is false", async () => {
    writeConfig({ resources: { claudeCode: false }, mcp: { servers: { a: { command: "bun", stages: ["run"] } } } });
    let catalogLoads = 0;
    _mcpLockCommandDeps.loadResourceCatalog = (async (options) => {
      catalogLoads++;
      return loadResourceCatalog(options);
    }) as typeof loadResourceCatalog;

    await lock();

    expect(Object.keys(requested[0] ?? {})).toEqual(["a"]);
    expect(catalogLoads).toBe(0);
  });

  test("a configured server keeps its own block over a catalog server with the same id", async () => {
    writeConfig({ mcp: { servers: { ctx: configured("mine") } } });

    await lock();

    expect(requested[0]?.ctx?.command).toBe("mine");
  });

  test("loads the catalog with no nax plugin packages and the seam's env", async () => {
    const seen: Parameters<typeof loadResourceCatalog>[0][] = [];
    _mcpLockCommandDeps.loadResourceCatalog = (async (options) => {
      seen.push(options);
      return loadResourceCatalog(options);
    }) as typeof loadResourceCatalog;
    _mcpLockCommandDeps.loadConfig = (async () => makeNaxConfig()) as typeof _mcpLockCommandDeps.loadConfig;

    await lock();

    expect(seen[0]?.naxPluginPackages).toEqual([]);
    expect(seen[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: claudeDir });
    expect(seen[0]?.repoRoot).toBe(projectDir);
  });
});
