import { afterEach, describe, expect, mock, test } from "bun:test";
import { join, resolve } from "node:path";
import { assertDefined, makeLogger, makeNaxConfig, makePRD, makeStory, withTempDir } from "@test/helpers";
import { _chatMcpDeps, type ChatMcp, createChatHost, createChatMcp, createChatStorage } from "@/chat";
import { _chatCommandDeps, chatCommand } from "@/cli/chat";
import { featureDir, globalConfigDir } from "@/config";
import { NaxError } from "@/errors";
import type { McpPool } from "@/mcp";
import { PluginRegistry } from "@/plugins";
import { buildResourceCatalog, loadResourceCatalog } from "@/resources";

function emptyMcp(overrides: Partial<ChatMcp> = {}): ChatMcp {
  return {
    state: { servers: [], diagnostics: [], events: () => [], withheld: () => [] },
    providers: [],
    close: async () => {},
    ...overrides,
  };
}

function fixture() {
  const config = makeNaxConfig({ models: { native: { balanced: "test/model" } } });
  const logger = makeLogger();
  const storage = createChatStorage({ pid: process.pid, now: () => new Date(), logger });
  const host = Object.assign(
    createChatHost({ config, storage, cwd: "/r", repoRoot: "/r", chain: null, now: () => new Date(), logger }),
    {
      start: mock(async () => {}),
      close: mock(async () => {}),
    },
  );
  const order: string[] = [];
  const deps = {
    ..._chatCommandDeps,
    createAcpCatalog: (): import("@/chat").AcpCatalog => ({
      load: async () => {},
      warm: () => {},
      close: () => {},
      rows: () => [],
      effortLevels: () => ["default"],
      installed: () => true,
      unavailable: () => undefined,
      opened: () => {},
      failed: () => {},
    }),
    collectAuthList: mock(
      async (_ids: readonly string[]): Promise<import("@/cli/auth-list").AuthListReport> => ({
        source: "file",
        providers: [],
      }),
    ),
    listCatalogModels: mock(async (_ids: readonly string[]): Promise<readonly string[]> => []),
    stdinIsTTY: () => true,
    ensureTrusted: mock(async (_cwd: string) => {
      order.push("trust");
    }),
    findProjectDir: () => "/r/.nax",
    loadConfig: mock(async () => {
      order.push("config");
      return config;
    }),
    loadPlugins: mock(async (..._args: Parameters<typeof _chatCommandDeps.loadPlugins>) => new PluginRegistry([])),
    loadResourceCatalog: mock(async (..._args: Parameters<typeof loadResourceCatalog>) => buildResourceCatalog([])),
    createChatMcp: mock(
      async (..._args: Parameters<typeof _chatCommandDeps.createChatMcp>): Promise<ChatMcp> => emptyMcp(),
    ),
    env: { CLAUDE_CONFIG_DIR: "/nonexistent-claude" },
    initInteractionChain: async () => null,
    createChatStorage: () => storage,
    createChatHost: mock((_input: Parameters<typeof createChatHost>[0]) => host),
    renderChat: () => ({ unmount() {}, waitUntilExit: async () => {} }),
    onSignal: () => () => {},
    writeErr: mock((_message: string) => {}),
    writeOut: mock((_message: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return { deps, order };
}

const mcpOriginals = { ..._chatMcpDeps };
afterEach(() => {
  Object.assign(_chatMcpDeps, mcpOriginals);
});

describe("chatCommand resources and trust", () => {
  test.each([{ entry: ["bun", "/n.ts"] }, { entry: undefined }])(
    "US-013 AC-19/20 forwards only a defined naxEntry: %j",
    async ({ entry }) => {
      const { deps } = fixture();
      Object.assign(deps, { naxEntry: () => entry });
      await chatCommand({ dir: "/r" }, deps);
      const input = deps.createChatHost.mock.calls[0]?.[0];
      assertDefined(input, "host dependencies");
      if (entry) expect(input).toHaveProperty("naxEntry", entry);
      else expect(input).not.toHaveProperty("naxEntry");
    },
  );
  test.each([
    [
      "AC-1–4",
      new NaxError("refused", "PROJECT_UNTRUSTED", { root: "/r", hint: "run: nax trust add /r" }),
      2,
      ["Project not trusted: /r", "run: nax trust add /r"],
    ],
    ["AC-5–6", new NaxError("bad store", "TRUST_STORE_UNREADABLE"), 2, ["bad store"]],
    ["AC-7–9", new Error("x"), 1, ["x"]],
  ] as const)("%s stops composition on trust rejection", async (_ac, error, code, messages) => {
    const { deps } = fixture();
    deps.ensureTrusted.mockRejectedValue(error);
    await chatCommand({ dir: "/r" }, deps);
    for (const message of messages) expect(deps.writeErr).toHaveBeenCalledWith(message);
    expect(deps.setExitCode).toHaveBeenCalledWith(code);
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.loadPlugins).not.toHaveBeenCalled();
    expect(deps.createChatHost).not.toHaveBeenCalled();
  });
  test("AC-10 trusts resolved cwd before config; AC-12/15 composes plugins and skills", async () => {
    const { deps, order } = fixture();
    await chatCommand({ dir: "/r/sub/.." }, deps);
    expect(deps.ensureTrusted).toHaveBeenCalledWith(resolve("/r/sub/.."));
    expect(order).toEqual(["trust", "config"]);
    expect(deps.loadPlugins).toHaveBeenCalledWith(
      join(globalConfigDir(), "plugins"),
      "/r/.nax/plugins",
      [],
      "/r",
      undefined,
    );
    expect(deps.createChatHost.mock.calls[0]?.[0].resources?.toolProviders[0]?.id).toBe("nax-skills");
  });
  test("AC-11 non-TTY never trusts", async () => {
    const { deps } = fixture();
    deps.stdinIsTTY = () => false;
    await chatCommand({}, deps);
    expect(deps.ensureTrusted).not.toHaveBeenCalled();
  });
  test("AC-13/14 plugin failure warns and still creates host", async () => {
    const { deps } = fixture();
    deps.loadPlugins.mockRejectedValue(new Error("boom"));
    await chatCommand({}, deps);
    expect(deps.writeErr).toHaveBeenCalledWith("nax plugins unavailable: boom");
    expect(deps.createChatHost).toHaveBeenCalledTimes(1);
  });
  test("AC-16 real catalog discovers registry skill directories", async () => {
    await withTempDir(async (dir) => {
      const { deps } = fixture();
      await Bun.write(
        join(dir, "skills/kit-skill/SKILL.md"),
        "---\nname: kit-skill\ndescription: Kit skill\n---\nKit body",
      );
      const registry = Object.assign(new PluginRegistry([]), {
        getResourceDirs: () => [{ plugin: "kit", skills: join(dir, "skills") }],
      });
      deps.loadPlugins.mockResolvedValue(registry);
      deps.findProjectDir = () => join(dir, ".nax");
      deps.loadResourceCatalog.mockImplementation(loadResourceCatalog);
      deps.env = { CLAUDE_CONFIG_DIR: join(dir, "empty-claude") };
      await chatCommand({ dir }, deps);
      expect(deps.createChatHost.mock.calls[0]?.[0].resources?.catalog.findSkill("kit-skill")?.origin).toEqual({
        kind: "nax-plugin",
        plugin: "kit",
      });
    });
  });
});

async function workflowFixture(dir: string) {
  const { deps } = fixture();
  deps.findProjectDir = () => join(dir, ".nax");
  deps.loadConfig.mockResolvedValue(
    makeNaxConfig({
      name: "proj-x",
      models: { native: { balanced: "test/model" } },
      execution: { mode: "pipeline", maxIterations: 2 },
    }),
  );
  await Bun.write(
    join(featureDir(dir, "f1"), "prd.json"),
    JSON.stringify(
      makePRD({
        userStories: Array.from({ length: 3 }, (_, i) => makeStory({ id: `US-${i + 1}`, status: "pending" })),
      }),
    ),
  );
  await chatCommand({ dir }, deps);
  expect(deps.setExitCode).not.toHaveBeenCalled();
  const provider = deps.createChatHost.mock.calls[0]?.[0].resources?.toolProviders.find((p) => p.id === "nax-workflow");
  assertDefined(provider, "workflow provider handed to createChatHost");
  return provider;
}

async function workflowState(dir: string) {
  const provider = await workflowFixture(dir);
  const tool = (await provider.tools(dir)).find((t) => t.localName === "state");
  assertDefined(tool, "state tool");
  const result = await tool.run(
    { feature: "f1" },
    {
      root: dir,
      resolvedPaths: [],
      maxBytes: 300_000,
      maxFileBytes: 300_000,
    },
  );
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content);
}

describe("chatCommand workflow composition", () => {
  test("US-006 AC-2 reads the fixture PRD through the actual state tool", async () => {
    await withTempDir(async (dir) => {
      expect((await workflowState(dir)).prd.total).toBe(3);
    });
  });
  test("US-006 AC-3 threads loaded execution.maxIterations", async () => {
    await withTempDir(async (dir) => {
      expect((await workflowState(dir)).warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("execution.maxIterations is 2")]),
      );
    });
  });
  test("US-006 AC-4 provides nonempty workflow instructions", async () => {
    await withTempDir(async (dir) => {
      const provider = await workflowFixture(dir);
      const instructions = await provider.instructions?.(dir);
      expect(instructions).toBeString();
      expect(instructions).toContain("nax-workflow__state");
    });
  });
  test("US-006 AC-5 resolves the configured project key under isolated global storage", async () => {
    await withTempDir(async (dir) => {
      const original = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(dir, "global");
      try {
        await Bun.write(join(dir, "global/proj-x/features/f1/runs/2026-10-03T00-00-00.jsonl"), "{}\n");
        expect((await workflowState(dir)).lastRunLog).toBe("2026-10-03T00-00-00");
      } finally {
        if (original === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
        else process.env.NAX_GLOBAL_CONFIG_DIR = original;
      }
    });
  });
});

function dockerProvider(id: string): ChatMcp["providers"][number] {
  return { id, kind: "discovered", stages: ["*"], tools: async () => [] };
}

describe("chatCommand MCP composition", () => {
  test("AC-15 appends MCP providers after the skills provider", async () => {
    const { deps } = fixture();
    const mcp = emptyMcp({ providers: [dockerProvider("docs")] });
    deps.createChatMcp.mockResolvedValue(mcp);
    await chatCommand({}, deps);
    const resources = deps.createChatHost.mock.calls[0]?.[0].resources;
    expect(resources?.toolProviders.map((p) => p.id)).toEqual(["nax-skills", "nax-workflow", "docs"]);
    expect(resources?.mcp).toBe(mcp.state);
    expect(deps.createChatMcp.mock.calls[0]?.[0]).toMatchObject({ repoRoot: "/r", env: deps.env });
  });
  test("AC-16 real catalog and createChatMcp build the pool from a fixture .claude.json", async () => {
    await withTempDir(async (dir) => {
      const { deps } = fixture();
      await Bun.write(
        join(dir, "claude", ".claude.json"),
        JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "docs-mcp" } } }),
      );
      deps.env = { CLAUDE_CONFIG_DIR: join(dir, "claude") };
      deps.findProjectDir = () => join(dir, ".nax");
      deps.loadResourceCatalog.mockImplementation(loadResourceCatalog);
      deps.createChatMcp.mockImplementation(createChatMcp);
      const pool: McpPool = {
        listTools: async () => [],
        call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
        events: () => [],
        close: async () => {},
      };
      const createMcpPool = mock((_opts: Parameters<typeof _chatMcpDeps.createMcpPool>[0]) => pool);
      _chatMcpDeps.createMcpPool = createMcpPool;
      _chatMcpDeps.readLock = async () => ({ version: 1, servers: { docs: {} } });
      await chatCommand({ dir }, deps);
      const servers = createMcpPool.mock.calls[0]?.[0].servers;
      expect(servers?.docs?.stages).toEqual(["*"]);
      expect(servers?.docs?.command).toBe("docs-mcp");
    });
  });
  test("AC-17 teardown closes MCP before the plugin registry", async () => {
    const { deps } = fixture();
    const order: string[] = [];
    const registry = Object.assign(new PluginRegistry([]), {
      teardownAll: mock(async () => {
        order.push("registry");
      }),
    });
    deps.loadPlugins.mockResolvedValue(registry);
    deps.createChatMcp.mockResolvedValue(
      emptyMcp({
        close: async () => {
          order.push("mcp");
        },
      }),
    );
    await chatCommand({}, deps);
    await deps.createChatHost.mock.calls[0]?.[0].resources?.teardown();
    expect(order).toEqual(["mcp", "registry"]);
  });
  test("AC-18 teardown still tears the registry down when the MCP close rejects", async () => {
    const { deps } = fixture();
    const registry = Object.assign(new PluginRegistry([]), { teardownAll: mock(async () => {}) });
    deps.loadPlugins.mockResolvedValue(registry);
    deps.createChatMcp.mockResolvedValue(
      emptyMcp({
        close: async () => {
          throw new Error("pool close failed");
        },
      }),
    );
    await chatCommand({}, deps);
    const resources = deps.createChatHost.mock.calls[0]?.[0].resources;
    assertDefined(resources, "resources");
    await resources.teardown().catch(() => {});
    expect(registry.teardownAll).toHaveBeenCalledTimes(1);
  });
  test("AC-19/20/21 createChatMcp failure tears the registry down, reports and exits 1", async () => {
    const { deps } = fixture();
    const registry = Object.assign(new PluginRegistry([]), { teardownAll: mock(async () => {}) });
    deps.loadPlugins.mockResolvedValue(registry);
    deps.createChatMcp.mockRejectedValue(new Error("mcp compose failed"));
    await chatCommand({}, deps);
    expect(registry.teardownAll).toHaveBeenCalledTimes(1);
    expect(deps.writeErr).toHaveBeenCalledWith("mcp compose failed");
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.createChatHost).not.toHaveBeenCalled();
  });
});
