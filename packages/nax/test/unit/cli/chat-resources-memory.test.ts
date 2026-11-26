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
import type { MemoryNoteWrite, MemorySaveResult } from "@nathapp/nax-agent";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import {
  type AcpCatalog,
  type ChatAskController,
  type ChatMcp,
  createChatHost,
  createChatStorage,
  type MemoryCompactOffer,
} from "@/chat";
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
  // A pass-through offer, so the host this composition builds is the host the
  // resources carry — the wrapping itself is US-018's own file's subject.
  const offer = passThroughOffer();
  const createMemoryCompactOfferMock = mock(
    (_input: Parameters<typeof _chatCommandDeps.createMemoryCompactOffer>[0]): MemoryCompactOffer => offer,
  );
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
    createMemoryCompactOffer: createMemoryCompactOfferMock,
    env: { CLAUDE_CONFIG_DIR: "/nonexistent-claude" },
    initInteractionChain: async () => null,
    createChatStorage: () => storage,
    createChatHost: createChatHostMock,
    loadAgentHookHandlers: mock(
      async (_input: Parameters<typeof _chatCommandDeps.loadAgentHookHandlers>[0]): Promise<LoopHandlerSet> => [],
    ),
    renderChat: mock(() => ({ unmount() {}, waitUntilExit: async () => {} })),
    onSignal: () => () => {},
    writeErr: mock((_message: string) => {}),
    writeOut: mock((_message: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return { deps, config, createChatHostMock, createMemoryHostMock, createMemoryCompactOfferMock, host, memory };
}

/** The offer that changes nothing: the host it observes is the host it hands back. */
function passThroughOffer(): MemoryCompactOffer {
  return { observe: (host: MemoryHost): MemoryHost => host, attach: () => {}, check: async () => {} };
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

/**
 * `memory-compaction US-018`: the one compaction offer a chat session makes.
 *
 * The offer itself is US-017's; what is under test here is the wiring — that
 * `composeChat` builds exactly one offer through `_chatCommandDeps`, hands the
 * host it observed to both memory surfaces, attaches the created host's asks,
 * and fires one unawaited check once the session has started.
 */

/** The offer spy: what `chatCommand` asked of it, and in what order. */
function offerSpy(observed: MemoryHost, order: string[]) {
  const observe = mock((_host: MemoryHost): MemoryHost => {
    order.push("observe");
    return observed;
  });
  const attach = mock((_asks: ChatAskController): void => {
    order.push("attach");
  });
  const check = mock((): Promise<void> => {
    order.push("check");
    return Promise.resolve();
  });
  const offer: MemoryCompactOffer = { observe, attach, check };
  return { offer, observe, attach, check };
}

/** The host the offer hands back, told apart from the one it was given. */
function observedHost(host: MemoryHost) {
  const save = mock(
    async (write: MemoryNoteWrite): Promise<MemorySaveResult> => ({
      slug: write.slug,
      status: "active",
      delivered: false,
    }),
  );
  return { observed: { ...host, save }, save };
}

describe("chatCommand compaction offer", () => {
  test("memory-compaction US-018 AC-1: resources.memory is the host the offer observed", async () => {
    const { deps, createChatHostMock, memory } = fixture();
    const order: string[] = [];
    const { observed } = observedHost(memory);
    const spy = offerSpy(observed, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(spy.observe).toHaveBeenCalledTimes(1);
    expect(spy.observe.mock.calls[0]?.[0]).toBe(memory);
    expect(composedResources(createChatHostMock).memory).toBe(observed);
  });

  test("memory-compaction US-018 AC-2: a save through the nax-memory save tool reaches the observed host", async () => {
    const { deps, createChatHostMock, memory } = fixture();
    const order: string[] = [];
    const { observed, save } = observedHost(memory);
    const spy = offerSpy(observed, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    const provider = composedResources(createChatHostMock).toolProviders.find(({ id }) => id === "nax-memory");
    assertDefined(provider, "nax-memory tool provider");
    const tool = (await provider.tools(REPO_ROOT)).find(({ localName }) => localName === "save");
    assertDefined(tool, "nax-memory save tool");
    await tool.run(
      { slug: "note-one", type: "project", description: "one fact", body: "the body" },
      { root: REPO_ROOT, resolvedPaths: [], maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      slug: "note-one",
      type: "project",
      scope: "project",
      description: "one fact",
      body: "the body",
    });
  });

  test("memory-compaction US-018 AC-3: attaches the created host's asks once", async () => {
    const { deps, memory, host } = fixture();
    const order: string[] = [];
    const spy = offerSpy(memory, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(spy.attach).toHaveBeenCalledTimes(1);
    expect(spy.attach.mock.calls[0]?.[0]).toBe(host.asks);
  });

  test("memory-compaction US-018 AC-4: attaches before it checks", async () => {
    const { deps, memory } = fixture();
    const order: string[] = [];
    const spy = offerSpy(memory, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(order.filter((step) => step === "attach" || step === "check")).toEqual(["attach", "check"]);
  });

  test("memory-compaction US-018 AC-5: checks once, after startHost resolves", async () => {
    const { deps, memory, host } = fixture();
    const order: string[] = [];
    host.start.mockImplementation(async () => {
      order.push("start");
    });
    const spy = offerSpy(memory, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(spy.check).toHaveBeenCalledTimes(1);
    // The check is the last thing asked of the offer, and only after the session opened.
    expect(order.at(-1)).toBe("check");
    expect(order.indexOf("start")).toBeLessThan(order.indexOf("check"));
  });

  test("memory-compaction US-018 AC-5: a failed start asks the offer nothing", async () => {
    const { deps, memory, host } = fixture();
    const order: string[] = [];
    host.start.mockRejectedValue(new Error("start failed"));
    const spy = offerSpy(memory, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(spy.check).not.toHaveBeenCalled();
    expect(order).toEqual(["observe", "attach"]);
  });

  test("memory-compaction US-018 AC-6: a check that never settles still lets the shell start", async () => {
    const { deps } = fixture();
    const check = mock(
      (): Promise<void> =>
        // Never settles: an awaited check would hold the shell for the whole session.
        new Promise<void>(() => {}),
    );
    const offer: MemoryCompactOffer = { observe: (observed) => observed, attach: () => {}, check };
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => offer });
    expect(check).toHaveBeenCalledTimes(1);
    expect(deps.renderChat).toHaveBeenCalledTimes(1);
  });

  test("memory-compaction US-018 AC-7: with memory disabled the offer observes nothing", async () => {
    const { deps, createMemoryHostMock, createChatHostMock, memory } = fixture();
    createMemoryHostMock.mockResolvedValue(null);
    const order: string[] = [];
    const spy = offerSpy(memory, order);
    await chatCommand({ dir: REPO_ROOT }, { ...deps, createMemoryCompactOffer: () => spy.offer });
    expect(spy.observe).not.toHaveBeenCalled();
    // Still wired: the session's own check runs, there is just nothing to observe.
    expect(spy.check).toHaveBeenCalledTimes(1);
    expect(composedResources(createChatHostMock)).not.toHaveProperty("memory");
  });

  test("memory-compaction US-018 AC-8: builds the offer from the loaded config and the resolved root", async () => {
    const { deps, config, createMemoryHostMock, memory } = fixture();
    const order: string[] = [];
    const spy = offerSpy(memory, order);
    const createMemoryCompactOffer = mock(
      (_input: Parameters<typeof _chatCommandDeps.createMemoryCompactOffer>[0]): MemoryCompactOffer => spy.offer,
    );
    await chatCommand({ dir: REPO_ROOT, profile: ["fast"] }, { ...deps, createMemoryCompactOffer });
    expect(createMemoryCompactOffer).toHaveBeenCalledTimes(1);
    const input = createMemoryCompactOffer.mock.calls[0]?.[0];
    assertDefined(input, "createMemoryCompactOffer input");
    // The config the command loaded, not a second one; the root its `.nax` sits in.
    expect(input.config).toBe(config);
    expect(input.repoRoot).toBe(dirname(NAX_DIR));
    // The chat's own logger, the same one the memory host logs through.
    expect(input.logger.warn).toBe(createMemoryHostMock.mock.calls[0]?.[0].logger?.warn);
  });
});
