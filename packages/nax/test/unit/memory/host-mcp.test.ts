/**
 * host.ts — provider composition, remote-first search and close for the MCP memory provider.
 *
 * Covers US-004 AC-1..AC-19 and AC-24..AC-30 at the `createMemoryHost` entry point. The
 * provider-selection cases stub `_memoryHostDeps.createMcpPool` / `createMcpMemoryProvider`;
 * the offline cases compose the real MCP provider over a fake pool so the real outbox runs.
 * The instruction cases (AC-20..AC-23, AC-31) live in `tool-provider.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryStore, MEMORY_OP_TIMEOUT_MS, type MemoryHit, type MemoryProvider } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
  withTimerSpy,
} from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import type { McpCallResult, McpPool, McpToolDescriptor } from "@/mcp";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";
import { createMcpIdMap } from "@/memory/mcp-id-map";

const SERVER = "om";
const WARN_MESSAGE = "memory remote search failed";

/** The configured server: `mcp.servers.om`, with the call timeout the provider must be given. */
function omServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    url: "http://localhost:8765/mcp",
    args: [],
    env: {},
    stages: ["*"],
    timeoutMs: 4321,
    enabled: true,
    ...overrides,
  };
}

/** A config whose memory provider is `mcp` over server `om`; `memory` and `server` refine it. */
function mcpConfig(
  memory: { tools?: { forget?: string }; args?: { id?: string } } = {},
  server: Partial<McpServerConfig> = {},
): NaxConfig {
  return makeNaxConfig({
    memory: {
      provider: "mcp",
      mcp: {
        server: SERVER,
        tools: { search: "search_memory", add: "add_memories", ...memory.tools },
        args: { query: "query", text: "text", ...memory.args },
      },
    },
    mcp: { servers: { [SERVER]: omServer(server) } },
  });
}

/** A pool whose methods are the given ones; everything else is inert. */
function fakePool(overrides: Partial<McpPool> = {}): McpPool {
  return {
    listTools: async () => [],
    call: async () => ({ content: "", isError: false, bytesPreTruncation: 0 }),
    events: () => [],
    close: async () => {},
    ...overrides,
  };
}

function hit(slug: string, overrides: Partial<MemoryHit> = {}): MemoryHit {
  return {
    slug,
    scope: "project",
    type: "reference",
    status: "active",
    description: `remote ${slug}`,
    snippet: `remote ${slug}`,
    score: 1,
    ...overrides,
  };
}

/** A provider that is not the real MCP one: the id is fixed and `search` is whatever the case needs. */
function stubProvider(search?: MemoryProvider["search"]): MemoryProvider {
  return {
    id: `mcp:${SERVER}`,
    pull: async () => ({ notes: [], done: true }),
    push: async (request) => ({ id: request.clientId, status: "active" }),
    reachable: async () => true,
    ...(search === undefined ? {} : { search }),
  };
}

function tool(name: string): McpToolDescriptor {
  return { name, description: name, inputSchema: { type: "object" } };
}

describe("memory host MCP composition", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-mcp-global-");
    repoRoot = makeTempDir("nax-host-mcp-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  async function open(config: NaxConfig): Promise<MemoryHost> {
    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** Write one note into the mirror the host reads. */
  async function writeNote(host: MemoryHost, slug: string, scope: "project" | "user", description: string) {
    const store = createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
    await store.writeNote({
      id: slug,
      slug,
      type: scope === "user" ? "user" : "project",
      scope,
      description,
      source: "nax-chat",
      updatedAt: "2026-11-02T08:00:00Z",
      status: "active",
      body: `body of ${slug}`,
    });
  }

  /** Stub both factories; returns the stubs and the pool the host will own. */
  function stubFactories(provider: MemoryProvider) {
    const pool = fakePool({ close: mock(async () => {}) });
    const createMcpPool = mock((_input: Parameters<typeof _memoryHostDeps.createMcpPool>[0]) => pool);
    const createMcpMemoryProvider = mock(
      (_input: Parameters<typeof _memoryHostDeps.createMcpMemoryProvider>[0]) => provider,
    );
    _memoryHostDeps.createMcpPool = createMcpPool;
    _memoryHostDeps.createMcpMemoryProvider = createMcpMemoryProvider;
    return { pool, createMcpPool, createMcpMemoryProvider };
  }

  function remoteWarns() {
    return logger.calls.filter((call) => call.level === "warn" && call.message === WARN_MESSAGE);
  }

  describe("provider selection", () => {
    test("AC-1 a local provider host reports providerId local", async () => {
      const host = await open(makeNaxConfig());

      expect(host.providerId).toBe("local");
    });

    test("AC-2 a local provider host does not create an MCP pool", async () => {
      const { createMcpPool } = stubFactories(stubProvider());

      await open(makeNaxConfig());

      expect(createMcpPool).not.toHaveBeenCalled();
    });

    test("AC-3 an MCP host creates one pool holding exactly the configured server", async () => {
      const config = mcpConfig();
      const { createMcpPool } = stubFactories(stubProvider());

      await open(config);

      expect(createMcpPool.mock.calls).toEqual([[{ servers: { [SERVER]: omServer() } }]]);
      expect(config.mcp?.servers[SERVER]).toEqual(omServer());
    });

    test("AC-4 the provider factory receives the server, repo root, memory.mcp and the call timeout", async () => {
      const config = mcpConfig();
      const { createMcpMemoryProvider, pool } = stubFactories(stubProvider());

      await open(config);

      const input = createMcpMemoryProvider.mock.calls[0]?.[0];
      assertDefined(input, "the provider factory input");
      expect({
        pool: input.pool === pool,
        serverId: input.serverId,
        workdir: input.workdir,
        mcp: input.mcp,
        callTimeoutMs: input.callTimeoutMs,
        logger: input.logger === logger,
      }).toEqual({
        pool: true,
        serverId: SERVER,
        workdir: repoRoot,
        mcp: {
          server: SERVER,
          tools: { search: "search_memory", add: "add_memories" },
          args: { query: "query", text: "text" },
        },
        callTimeoutMs: 4321,
        logger: true,
      });
    });

    test("AC-4 the id map is built over the host's own directories for the server", async () => {
      const idMap = { ids: async () => [] as readonly string[], add: async () => {}, drop: async () => {} };
      const createMcpIdMap = mock((_input: Parameters<typeof _memoryHostDeps.createMcpIdMap>[0]) => idMap);
      _memoryHostDeps.createMcpIdMap = createMcpIdMap;
      const { createMcpMemoryProvider } = stubFactories(stubProvider());

      const host = await open(mcpConfig());

      expect(createMcpIdMap.mock.calls).toEqual([[{ dirs: host.dirs, server: SERVER }]]);
      expect(createMcpMemoryProvider.mock.calls[0]?.[0].idMap).toBe(idMap);
    });

    test("AC-5 an MCP host reports the provider's id", async () => {
      stubFactories({ ...stubProvider(), id: "mcp:stub-id" });

      const host = await open(mcpConfig());

      expect(host.providerId).toBe("mcp:stub-id");
    });
  });

  describe("remote search", () => {
    test("AC-6 puts the remote hit before the local hit", async () => {
      stubFactories(stubProvider(async () => [hit("mcp-r1")]));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["mcp-r1", "local-1"]);
    });

    test("AC-7 returns a slug held by both once, as the remote hit", async () => {
      stubFactories(stubProvider(async () => [hit("local-1", { description: "from remote" })]));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => [h.slug, h.description])).toEqual([["local-1", "from remote"]]);
    });

    test("AC-8 cuts the merged result to the limit, keeping the remote hit", async () => {
      stubFactories(stubProvider(async () => [hit("mcp-r1")]));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 1 });

      expect(hits.map((h) => h.slug)).toEqual(["mcp-r1"]);
    });

    test("AC-9 asks the provider with scope project when the query has none", async () => {
      const search = mock(async (_input: { scope: "project" | "user"; text: string; limit: number }) => [
        hit("mcp-r1"),
      ]);
      stubFactories(stubProvider(search));
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", limit: 7 });

      expect(search.mock.calls).toEqual([[{ scope: "project", text: "alpha", limit: 7 }]]);
    });

    test("AC-9 asks the provider for a project-scoped query", async () => {
      const search = mock(async (_input: { scope: "project" | "user"; text: string; limit: number }) => []);
      stubFactories(stubProvider(search));
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", scope: "project", limit: 3 });

      expect(search.mock.calls).toEqual([[{ scope: "project", text: "alpha", limit: 3 }]]);
    });

    test("AC-10 does not ask the provider for a user-scope search", async () => {
      const search = mock(async () => [hit("mcp-r1")]);
      stubFactories(stubProvider(search));
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", scope: "user", limit: 10 });

      expect(search).not.toHaveBeenCalled();
    });

    test("AC-11 a user-scope search resolves the local user hits", async () => {
      stubFactories(stubProvider(async () => [hit("mcp-r1")]));
      const host = await open(mcpConfig());
      await writeNote(host, "user-1", "user", "alpha user note");
      await writeNote(host, "proj-1", "project", "alpha project note");

      const hits = await host.search({ text: "alpha", scope: "user", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["user-1"]);
    });

    test("AC-12 resolves the local hits when the provider's search rejects", async () => {
      stubFactories(
        stubProvider(async () => {
          throw new Error("search down");
        }),
      );
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
    });

    test("AC-13 warns through the host logger when the provider's search rejects", async () => {
      stubFactories(
        stubProvider(async () => {
          throw new Error("search down");
        }),
      );
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", limit: 10 });

      expect(remoteWarns().map((call) => [call.stage, call.data])).toEqual([
        ["memory", { provider: `mcp:${SERVER}`, error: "search down" }],
      ]);
    });

    test("AC-14 resolves the local hits when the search outlives the deadline", async () => {
      _memoryHostDeps.remoteSearchTimeoutMs = 20;
      stubFactories(stubProvider(() => new Promise<readonly MemoryHit[]>(() => {})));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
    });

    test("AC-15 warns through the host logger when the search outlives the deadline", async () => {
      _memoryHostDeps.remoteSearchTimeoutMs = 20;
      stubFactories(stubProvider(() => new Promise<readonly MemoryHit[]>(() => {})));
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", limit: 10 });

      expect(remoteWarns()).toHaveLength(1);
    });

    test("the deadline defaults to the memory operation timeout", () => {
      expect(_memoryHostDeps.remoteSearchTimeoutMs).toBe(MEMORY_OP_TIMEOUT_MS);
    });

    test("leaves no timer armed once a remote search has settled", async () => {
      stubFactories(stubProvider(async () => [hit("mcp-r1")]));
      const host = await open(mcpConfig());

      const { leaked } = await withTimerSpy(() => host.search({ text: "alpha", limit: 10 }));

      expect(leaked).toEqual([]);
    });

    test("AC-16 resolves exactly the local hits when the provider has no search", async () => {
      stubFactories(stubProvider());
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
      expect(remoteWarns()).toEqual([]);
    });

    test("AC-16 a local-provider host searches only the local notes", async () => {
      const host = await open(makeNaxConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
    });
  });

  describe("close", () => {
    test("AC-17 closes the stubbed pool once", async () => {
      const { pool } = stubFactories(stubProvider());
      const host = await open(mcpConfig());

      await host.close?.();

      expect(pool.close).toHaveBeenCalledTimes(1);
    });

    test("AC-18 a second close resolves and does not close the pool again", async () => {
      const { pool } = stubFactories(stubProvider());
      const host = await open(mcpConfig());

      await host.close?.();
      await host.close?.();

      expect(pool.close).toHaveBeenCalledTimes(1);
    });

    test("AC-19 a local-provider host closes", async () => {
      const host = await open(makeNaxConfig());

      expect(typeof host.close).toBe("function");
      await expect(host.close?.()).resolves.toBeUndefined();
    });
  });

  describe("composed MCP provider over an unavailable or failing server", () => {
    /** Real provider, fake pool: the real outbox and reachability probe run. */
    function composeWith(pool: McpPool) {
      _memoryHostDeps.createMcpPool = () => pool;
    }

    const unavailable: ReadonlyArray<readonly [string, () => McpPool | undefined]> = [
      ["the connection failed (no tools)", () => fakePool({ listTools: async () => [] })],
      [
        "repository trust rejects the connection",
        () =>
          fakePool({
            listTools: async () => {
              throw new Error("repository is not trusted");
            },
          }),
      ],
      ["the server is disabled (real pool)", () => undefined],
    ];

    function configFor(forget: boolean, disabled: boolean): NaxConfig {
      return mcpConfig(forget ? { tools: { forget: "delete_memory" }, args: { id: "memory_id" } } : {}, {
        enabled: !disabled,
      });
    }

    /** Open a host whose pool is the case's; a disabled server keeps the real `createMcpPool`. */
    async function openUnavailable(
      poolOf: () => McpPool | undefined,
      title: string,
      forget: boolean,
    ): Promise<MemoryHost> {
      const pool = poolOf();
      if (pool !== undefined) composeWith(pool);
      return open(configFor(forget, title.includes("disabled")));
    }

    test.each(unavailable)("AC-24 a save is queued in the outbox when %s", async (title, poolOf) => {
      const host = await openUnavailable(poolOf, title, false);

      const result = await host.save({
        slug: "s1",
        type: "project",
        scope: "project",
        description: "d",
        body: "b",
      });

      expect(result.delivered).toBe(false);
      expect((await host.status()).queued).toBe(1);
      await host.close?.();
    });

    test.each(unavailable)(
      "AC-25 a configured forget with recorded remote ids is queued when %s",
      async (title, poolOf) => {
        const host = await openUnavailable(poolOf, title, true);
        await writeNote(host, "s1", "project", "alpha");
        await createMcpIdMap({ dirs: host.dirs, server: SERVER }).add("project", "s1", ["r1"]);

        const result = await host.forget({ scope: "project", slug: "s1", reason: "wrong" });

        expect(result.delivered).toBe(false);
        expect((await host.status()).queued).toBe(1);
        await host.close?.();
      },
    );

    test.each(unavailable)("AC-26 a forget with no tools.forget resolves deleted when %s", async (title, poolOf) => {
      const host = await openUnavailable(poolOf, title, false);
      await writeNote(host, "s1", "project", "alpha");

      const result = await host.forget({ scope: "project", slug: "s1", reason: "wrong" });

      expect(result.status).toBe("deleted");
      await host.close?.();
    });

    test.each(unavailable)("AC-27 search returns the local hits when %s", async (title, poolOf) => {
      const host = await openUnavailable(poolOf, title, false);
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
      await host.close?.();
    });

    /** A pool that lists the memory tools and answers `search_memory` with `answer`. */
    function searchingPool(answer: McpCallResult): McpPool {
      return fakePool({
        listTools: async () => [tool("search_memory"), tool("add_memories")],
        call: async () => answer,
      });
    }

    test("AC-28 an isError search answer is warned about through the host logger", async () => {
      composeWith(searchingPool({ content: "boom", isError: true, bytesPreTruncation: 4 }));
      const host = await open(mcpConfig());

      await host.search({ text: "alpha", limit: 10 });

      expect(remoteWarns().map((call) => call.data?.provider)).toEqual([`mcp:${SERVER}`]);
      expect(String(remoteWarns()[0]?.data?.error)).toContain("boom");
    });

    test("AC-29 an isError search answer leaves the local hits", async () => {
      composeWith(searchingPool({ content: "boom", isError: true, bytesPreTruncation: 4 }));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
    });

    test.each([
      ["not JSON", "no results here"],
      ["JSON without a supported item list", '{"memories":[{"memory":"x"}]}'],
    ])("AC-30 a search answer that is %s leaves the local hits", async (_title, content) => {
      composeWith(searchingPool({ content, isError: false, bytesPreTruncation: content.length }));
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["local-1"]);
      expect(remoteWarns()).toEqual([]);
    });

    test("a search answer with items puts the remote hit first through the real provider", async () => {
      composeWith(
        searchingPool({
          content: '[{"id":"a1","memory":"alpha remote fact"}]',
          isError: false,
          bytesPreTruncation: 0,
        }),
      );
      const host = await open(mcpConfig());
      await writeNote(host, "local-1", "project", "alpha local note");

      const hits = await host.search({ text: "alpha", limit: 10 });

      expect(hits.map((h) => h.slug)).toEqual(["mcp-a1", "local-1"]);
    });
  });
});
