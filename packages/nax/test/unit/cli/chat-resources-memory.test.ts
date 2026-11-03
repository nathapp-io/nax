/**
 * chat-resources-memory.test.ts — the memory host `nax chat` composes.
 *
 * Covers US-010 AC-5..AC-10: `chatResources()` builds the host through
 * `_chatCommandDeps.createMemoryHost`, hands it the chat's repo root and the
 * chat's own logger, stores a non-null host on `ChatResources.memory` and places
 * its provider directly after `nax-workflow` — before the MCP providers, so a
 * subagent (which takes `resources.toolProviders`) gets the tools too.
 *
 * `chatResources` is private, so every case reaches it the way the chat does:
 * through `chatCommand`, and then reads the `resources` the stubbed
 * `createChatHost` received. The memory host is stubbed at the dependency seam,
 * so no mirror is read and no note is written while this file runs.
 */

import { describe, expect, mock, test } from "bun:test";
import { dirname } from "node:path";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { type AcpCatalog, type ChatMcp, createChatHost, createChatStorage } from "@/chat";
import type { AuthListReport } from "@/cli/auth-list";
import { _chatCommandDeps, chatCommand } from "@/cli/chat";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";
import { PluginRegistry } from "@/plugins";
import { buildResourceCatalog, type loadResourceCatalog } from "@/resources";

/** The repo root and `.nax` directory the chat resolves by default in this file. */
const REPO_ROOT = "/r";
const NAX_DIR = "/r/.nax";

const EMPTY_MCP: ChatMcp = {
  state: { servers: [], diagnostics: [], events: () => [], withheld: () => [] },
  providers: [],
  close: async () => {},
};

/**
 * A host nothing here reads: every case asserts that the host arrives, where it
 * was placed and what it was built with — not what a note read returns. A read
 * therefore throws rather than standing in for a real mirror.
 */
function fakeMemoryHost(): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("the fake memory host is not read by this test");
  };
  return {
    dirs: { root: "/m", projectDir: "/m/project", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unread,
    getNote: unread,
    search: unread,
    renderIndex: unread,
    sync: unread,
    status: unread,
    save: unread,
    forget: unread,
    approve: unread,
  };
}

/** A provider like the one `createChatMcp` builds for a locked MCP server. */
function docsProvider(): ChatMcp["providers"][number] {
  return { id: "docs", kind: "discovered", stages: ["*"], tools: async () => [] };
}

/** The catalog stub: nothing installed, so only the composition's order is under test. */
function emptyAcpCatalog(): AcpCatalog {
  return {
    load: async () => {},
    warm: () => {},
    refresh: async () => [],
    close: () => {},
    rows: () => [],
    effortLevels: () => ["default"],
    installed: () => true,
    unavailable: () => undefined,
    opened: () => {},
    failed: () => {},
  };
}

/**
 * A `chatCommand` whose every external call is stubbed: the composition runs
 * end to end without a TTY, a trust store, a plugin directory or a mirror.
 * The two factories that receive the composed resources are returned so a case
 * can read their calls.
 */
function fixture() {
  const config = makeNaxConfig({ models: { native: { balanced: "test/model" } } });
  const logger = makeLogger();
  const storage = createChatStorage({ pid: process.pid, now: () => new Date(), logger });
  const host = Object.assign(
    createChatHost({
      config,
      storage,
      cwd: REPO_ROOT,
      repoRoot: REPO_ROOT,
      chain: null,
      now: () => new Date(),
      logger,
    }),
    { start: mock(async () => {}), close: mock(async () => {}) },
  );
  const memory = fakeMemoryHost();
  const createChatHostMock = mock((_input: Parameters<typeof createChatHost>[0]) => host);
  const createMemoryHostMock = mock(async (_input: CreateMemoryHostInput): Promise<MemoryHost | null> => memory);
  const deps = {
    ..._chatCommandDeps,
    createAcpCatalog: emptyAcpCatalog,
    collectAuthList: mock(
      async (_ids: readonly string[]): Promise<AuthListReport> => ({ source: "file", providers: [] }),
    ),
    listCatalogModels: mock(async (_ids: readonly string[]): Promise<readonly string[]> => []),
    stdinIsTTY: () => true,
    ensureTrusted: mock(async (_cwd: string) => {}),
    findProjectDir: () => NAX_DIR,
    loadConfig: mock(async () => config),
    loadPlugins: mock(async (..._args: Parameters<typeof _chatCommandDeps.loadPlugins>) => new PluginRegistry([])),
    loadResourceCatalog: mock(async (..._args: Parameters<typeof loadResourceCatalog>) => buildResourceCatalog([])),
    createChatMcp: mock(
      async (..._args: Parameters<typeof _chatCommandDeps.createChatMcp>): Promise<ChatMcp> => EMPTY_MCP,
    ),
    createMemoryHost: createMemoryHostMock,
    env: { CLAUDE_CONFIG_DIR: "/nonexistent-claude" },
    initInteractionChain: async () => null,
    createChatStorage: () => storage,
    createChatHost: createChatHostMock,
    loadAgentHookHandlers: mock(
      async (_input: Parameters<typeof _chatCommandDeps.loadAgentHookHandlers>[0]): Promise<LoopHandlerSet> => [],
    ),
    renderChat: () => ({ unmount() {}, waitUntilExit: async () => {} }),
    onSignal: () => () => {},
    writeErr: mock((_message: string) => {}),
    writeOut: mock((_message: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return { deps, config, createChatHostMock, createMemoryHostMock, memory };
}

/** The resources the chat handed its host, which is where `chatResources` result is read. */
function composedResources(createChatHostMock: ReturnType<typeof fixture>["createChatHostMock"]) {
  const resources = createChatHostMock.mock.calls[0]?.[0].resources;
  assertDefined(resources, "resources handed to createChatHost");
  return resources;
}

describe("chatCommand memory composition", () => {
  test("memory-chat US-010 AC-5: composes the host once, labelled nax-chat", async () => {
    const { deps, createMemoryHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    expect(createMemoryHostMock).toHaveBeenCalledTimes(1);
    expect(createMemoryHostMock.mock.calls[0]?.[0].source).toBe("nax-chat");
  });

  test("memory-chat US-010 AC-6: hands the host the chat's repo root and its config", async () => {
    const { deps, config, createMemoryHostMock } = fixture();
    // A `.nax` directory two levels down, so a mode that passed the cwd or the
    // `.nax` directory itself would not coincide with the expected value.
    deps.findProjectDir = () => "/repo/.nax";
    await chatCommand({ dir: "/repo" }, deps);
    expect(createMemoryHostMock.mock.calls[0]?.[0].repoRoot).toBe(dirname("/repo/.nax"));
    expect(createMemoryHostMock.mock.calls[0]?.[0].config).toBe(config);
  });

  test("memory-chat US-010 AC-7: hands the host the chat's logger", async () => {
    const { deps, createChatHostMock, createMemoryHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    const memoryLogger = createMemoryHostMock.mock.calls[0]?.[0].logger;
    assertDefined(memoryLogger, "logger handed to createMemoryHost");
    expect(typeof memoryLogger.warn).toBe("function");
    // The chat's own logger, not a second one: `composeChat` builds it before the resources.
    expect(memoryLogger.warn).toBe(createChatHostMock.mock.calls[0]?.[0].logger?.warn);
  });

  test("memory-chat US-010 AC-8: the resources carry the fake host", async () => {
    const { deps, createChatHostMock, memory } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    expect(composedResources(createChatHostMock).memory).toBe(memory);
  });

  test("memory-chat US-010 AC-9: the memory provider follows nax-workflow", async () => {
    const { deps, createChatHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    const ids = composedResources(createChatHostMock).toolProviders.map((provider) => provider.id);
    expect(ids.indexOf("nax-memory")).toBe(ids.indexOf("nax-workflow") + 1);
  });

  test("memory-chat US-010 AC-10: skills, workflow, memory, then the MCP providers", async () => {
    const { deps, createChatHostMock } = fixture();
    deps.createChatMcp.mockResolvedValue({ ...EMPTY_MCP, providers: [docsProvider()] });
    await chatCommand({ dir: REPO_ROOT }, deps);
    const ids = composedResources(createChatHostMock).toolProviders.map((provider) => provider.id);
    expect(ids).toEqual(["nax-skills", "nax-workflow", "nax-memory", "docs"]);
  });
});
