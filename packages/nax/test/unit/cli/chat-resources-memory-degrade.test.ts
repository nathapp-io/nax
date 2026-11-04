/**
 * chat-resources-memory-degrade.test.ts — the chat that starts without memory.
 *
 * Covers US-011 AC-1..AC-6: `chatResources()` treats the memory host as a
 * convenience, not a prerequisite. A host that `createMemoryHost` declines to
 * build (`null`, memory disabled) and a host it cannot build (`MEMORY_REPO_ROOT_UNRESOLVED`)
 * both leave `ChatResources` without `memory` and without its provider, and the
 * chat still composes and starts; the failure is reported once through the
 * chat's own logger, which writes to stderr when the CLI never initialised one.
 *
 * `chatResources` is private, so every case reaches it the way the chat does:
 * through `chatCommand`, and then reads the `resources` the stubbed
 * `createChatHost` received. The memory host is stubbed at the dependency seam,
 * so no mirror is read and no note is written while this file runs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { type AcpCatalog, type ChatMcp, createChatHost, createChatStorage } from "@/chat";
import type { AuthListReport } from "@/cli/auth-list";
import { _chatCommandDeps, chatCommand } from "@/cli/chat";
import { NaxError } from "@/errors";
import { resetLogger } from "@/logger";
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

/** The failure `memoryDirs` throws when it cannot canonicalise the repository root. */
function unresolvedRepoRoot(): NaxError {
  return new NaxError("[memory] cannot resolve repository root /r: ENOENT", "MEMORY_REPO_ROOT_UNRESOLVED", {
    stage: "memory",
    repoRoot: REPO_ROOT,
  });
}

/** The catalog stub: nothing installed, so only the composition is under test. */
function emptyAcpCatalog(): AcpCatalog {
  return {
    load: async () => {},
    warm: () => {},
    refresh: async () => [],
    close: async () => {},
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
 * `createMemoryHost` declines by default — the degenerate path every case here
 * describes — and a case that wants a rejection re-stubs it.
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
  const createChatHostMock = mock((_input: Parameters<typeof createChatHost>[0]) => host);
  const createMemoryHostMock = mock(async (_input: CreateMemoryHostInput): Promise<MemoryHost | null> => null);
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
  return { deps, createChatHostMock, createMemoryHostMock };
}

/** The resources the chat handed its host, which is where `chatResources` result is read. */
function composedResources(createChatHostMock: ReturnType<typeof fixture>["createChatHostMock"]) {
  const resources = createChatHostMock.mock.calls[0]?.[0].resources;
  assertDefined(resources, "resources handed to createChatHost");
  return resources;
}

/** The lines the chat wrote to stderr, in the order it wrote them. */
function stderrLines(writeErr: ReturnType<typeof fixture>["deps"]["writeErr"]): readonly string[] {
  return writeErr.mock.calls.map(([message]) => message);
}

// AC-5 asserts the stderr fallback, and a real logger is what replaces it, so
// every case starts from the state a `nax chat` launch is actually in.
beforeEach(() => {
  resetLogger();
});

describe("chatCommand without a memory host", () => {
  test("memory-chat US-011 AC-1: a declined host still hands createChatHost resources, with no memory", async () => {
    const { deps, createChatHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    expect(createChatHostMock).toHaveBeenCalledTimes(1);
    expect(composedResources(createChatHostMock)).not.toHaveProperty("memory");
  });

  test("memory-chat US-011 AC-2: no provider in those resources is nax-memory", async () => {
    const { deps, createChatHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    const ids = composedResources(createChatHostMock).toolProviders.map((provider) => provider.id);
    expect(ids).not.toContain("nax-memory");
  });

  test("memory-chat US-011 AC-3: an unresolvable repo root still lets chatCommand call createChatHost", async () => {
    const { deps, createChatHostMock, createMemoryHostMock } = fixture();
    createMemoryHostMock.mockRejectedValue(unresolvedRepoRoot());
    await chatCommand({ dir: REPO_ROOT }, deps);
    expect(createChatHostMock).toHaveBeenCalledTimes(1);
  });

  test("memory-chat US-011 AC-4: the resources it receives on that rejection carry no memory", async () => {
    const { deps, createChatHostMock, createMemoryHostMock } = fixture();
    createMemoryHostMock.mockRejectedValue(unresolvedRepoRoot());
    await chatCommand({ dir: REPO_ROOT }, deps);
    const resources = composedResources(createChatHostMock);
    expect({ memory: "memory" in resources, ids: resources.toolProviders.map((provider) => provider.id) }).toEqual({
      memory: false,
      ids: ["nax-skills", "nax-workflow"],
    });
  });

  test("memory-chat US-011 AC-5: the rejection is written to stderr as memory unavailable", async () => {
    const { deps, createMemoryHostMock } = fixture();
    createMemoryHostMock.mockRejectedValue(unresolvedRepoRoot());
    await chatCommand({ dir: REPO_ROOT }, deps);
    expect(stderrLines(deps.writeErr)).toEqual(["[chat] memory unavailable"]);
  });

  test("memory-chat US-011 AC-6: a declined host changes no output, exit code or resource value", async () => {
    const { deps, createChatHostMock } = fixture();
    await chatCommand({ dir: REPO_ROOT }, deps);
    const ids = composedResources(createChatHostMock).toolProviders.map((provider) => provider.id);
    expect({
      ids,
      exitCode: deps.setExitCode.mock.calls.length,
      stderr: stderrLines(deps.writeErr),
      summary: deps.writeOut.mock.calls.length,
    }).toEqual({ ids: ["nax-skills", "nax-workflow"], exitCode: 0, stderr: [], summary: 0 });
  });
});
