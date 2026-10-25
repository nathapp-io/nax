import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  buildResourceCatalog,
  type loadResourceCatalog,
  type McpServerResource,
  type ResourceCatalog,
  type ResourcePackage,
  resolveCatalogMcpConfig,
} from "@/resources";

type Load = typeof loadResourceCatalog;

const PROJECT = { kind: "claude-project" } as const;

function entry(name: string, command: string): McpServerResource {
  const server = { transport: "stdio", command, args: [], env: {} } as const;
  return { kind: "mcp", name, transport: "stdio", scope: "project", server, path: "/repo/.mcp.json", origin: PROJECT };
}

function catalogOf(...entries: McpServerResource[]): ResourceCatalog {
  const pkg: ResourcePackage = {
    id: "claude-project",
    origin: PROJECT,
    root: "/repo",
    skills: [],
    commands: [],
    agents: [],
    mcpServers: entries,
    hooks: [],
    diagnostics: [],
  };
  return buildResourceCatalog([pkg]);
}

const configured: McpServerConfig = {
  command: "mine",
  args: [],
  env: {},
  stages: ["run"],
  timeoutMs: 5,
  enabled: true,
  headers: {},
};

describe("resolveCatalogMcpConfig", () => {
  let loads: Parameters<Load>[0][];
  let load: Load;
  beforeEach(() => {
    loads = [];
    load = async (options) => {
      loads.push(options);
      return catalogOf(entry("ctx", "npx"));
    };
  });

  test("AC-3 never loads the catalog when Claude Code discovery is off", async () => {
    await resolveCatalogMcpConfig({
      config: makeNaxConfig({ resources: { claudeCode: false } }),
      repoRoot: "/repo",
      env: {},
      load,
    });
    expect(loads).toHaveLength(0);
  });

  test("AC-4 returns config.mcp itself when Claude Code discovery is off", async () => {
    const mcp = { servers: { a: configured } };
    const config = makeNaxConfig({ resources: { claudeCode: false }, mcp });
    expect(await resolveCatalogMcpConfig({ config, repoRoot: "/repo", env: {}, load })).toBe(config.mcp);
  });

  test("AC-4 returns undefined when discovery is off and no mcp is configured", async () => {
    const config = { ...makeNaxConfig({ resources: { claudeCode: false } }), mcp: undefined };
    expect(await resolveCatalogMcpConfig({ config, repoRoot: "/repo", env: {}, load })).toBeUndefined();
  });

  test("AC-5 includes a project catalog server and loads with the documented options", async () => {
    const config = makeNaxConfig();
    const env = { A: "1" };
    const result = await resolveCatalogMcpConfig({ config, repoRoot: "/repo", env, load });
    expect(result?.servers.ctx?.command).toBe("npx");
    expect(result?.servers.ctx?.stages).toEqual(["*"]);
    expect(loads).toEqual([{ repoRoot: "/repo", config, env, naxPluginPackages: [] }]);
  });

  describe("diagnostics", () => {
    const entries: LogEntry[] = [];
    let unsubscribe: () => void;
    beforeEach(() => {
      entries.length = 0;
      resetLogger();
      initLogger({ level: "silent" });
      unsubscribe = addSink((e) => void entries.push(e));
    });
    afterEach(() => {
      unsubscribe();
      resetLogger();
    });

    test("AC-6 logs each merge diagnostic at warn with stage resources", async () => {
      const shadowing: Load = async () => catalogOf(entry("a", "theirs"), entry("!!!", "x"));
      const config = makeNaxConfig({ mcp: { servers: { a: configured } } });
      await resolveCatalogMcpConfig({ config, repoRoot: "/repo", env: {}, load: shadowing });
      const warned = entries.filter((e) => e.stage === "resources");
      expect(warned.map((e) => e.level)).toEqual(["warn", "warn"]);
      expect(warned[0]?.message).toContain("mcp server a");
      expect(warned[0]?.message).toContain("is shadowed by config");
      expect(warned[1]?.message).toContain("yields no usable id");
    });
  });

  describe("lockedOnly", () => {
    const config = () => makeNaxConfig({ mcp: { servers: { a: configured } } });
    const lockWith =
      (...ids: string[]) =>
      async () => ({
        version: 1 as const,
        servers: Object.fromEntries(ids.map((id) => [id, {}])),
      });

    test("drops a catalog server the lock does not list, keeps configured ones", async () => {
      const result = await resolveCatalogMcpConfig({
        config: config(),
        repoRoot: "/repo",
        env: {},
        load,
        lockedOnly: true,
        readLock: lockWith("other"),
      });
      expect(Object.keys(result?.servers ?? {})).toEqual(["a"]);
    });

    test("keeps a catalog server the lock lists", async () => {
      const result = await resolveCatalogMcpConfig({
        config: config(),
        repoRoot: "/repo",
        env: {},
        load,
        lockedOnly: true,
        readLock: lockWith("ctx"),
      });
      expect(Object.keys(result?.servers ?? {}).sort()).toEqual(["a", "ctx"]);
    });

    test("with no lock at all drops every catalog server", async () => {
      const result = await resolveCatalogMcpConfig({
        config: config(),
        repoRoot: "/repo",
        env: {},
        load,
        lockedOnly: true,
        readLock: async () => undefined,
      });
      expect(Object.keys(result?.servers ?? {})).toEqual(["a"]);
    });

    test("passes the repo root to readLock", async () => {
      const seen: string[] = [];
      await resolveCatalogMcpConfig({
        config: config(),
        repoRoot: "/repo",
        env: {},
        load,
        lockedOnly: true,
        readLock: async (root) => {
          seen.push(root);
          return undefined;
        },
      });
      expect(seen).toEqual(["/repo"]);
    });
  });
});
