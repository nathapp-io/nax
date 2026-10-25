import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, LoopHandlerSet, SessionMeta } from "@nathapp/nax-agent";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import { _openChatSessionDeps, type OpenChatSessionRequest, openChatSession } from "@/chat/open-chat-session";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { buildResourceCatalog, createSkillsProvider } from "@/resources";

const originals = { ..._openChatSessionDeps };
const hosts: ReturnType<typeof createChatHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  Object.assign(_openChatSessionDeps, originals);
});
function fixture() {
  const events: string[] = [];
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: "resource-session",
    cwd: "/r",
    mode: "ask",
    model: "test/model",
    bashApproval: "gated",
    title: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  const session: AgentSession = {
    id: meta.sessionId,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close: async () => {
      events.push("close");
    },
  };
  const release = async () => {
    events.push("release");
  };
  const catalog = buildResourceCatalog([]);
  const pluginHandlers: LoopHandlerSet = [{ plugin: "kit", event: "before_turn", handler: async () => {} }];
  const resources: ChatResources = {
    catalog,
    toolProviders: [createSkillsProvider(async () => catalog)],
    pluginHandlers,
    naxPlugins: [{ name: "kit", provides: ["resources"] }],
    teardown: mock(async () => {
      events.push("teardown");
    }),
  };
  const storage = Object.assign(createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }), {
    acquireLock: async () => release,
    writeMeta: async () => {},
    readMeta: async () => meta,
  });
  const deps = {
    config: makeNaxConfig(),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage,
    now: () => new Date(),
    logger: makeLogger(),
  };
  const open = mock(async (request: OpenChatSessionRequest) => ({
    session,
    meta: { ...meta, mode: request.mode === "full" ? ("full" as const) : ("ask" as const) },
    release,
  }));
  const build = (withResources = true, withOpener = true) => {
    const host = createChatHost({ ...deps, ...(withResources ? { resources } : {}), ...(withOpener ? { open } : {}) });
    hosts.push(host);
    return host;
  };
  return { events, session, resources, open, build, deps };
}

describe("createChatHost resources", () => {
  test("AC-17/18/19 plugin-first frozen handlers persist across switch and resume", async () => {
    const f = fixture();
    const host = f.build();
    await host.start({ mode: "guarded", model: "test/model" });
    const first = f.open.mock.calls[0]?.[0];
    expect(first?.loopHandlers[0]).toBe(f.resources.pluginHandlers[0]);
    expect(first?.loopHandlers.slice(1).map((entry) => entry.event)).toEqual(
      createRuleDeliveryHandlers({ repoRoot: "/r", overrideMode: "merge" }).map((entry) => entry.event),
    );
    expect(first?.loopHandlers.length).toBeGreaterThan(1);
    expect(Object.isFrozen(first?.loopHandlers)).toBe(true);
    await host.switchTo({ mode: "full" });
    await host.resume({ id: "another-id" });
    for (const [request] of f.open.mock.calls) {
      expect(request.loopHandlers).toBe(first?.loopHandlers);
      expect(request.toolProviders).toBe(f.resources.toolProviders);
    }
    expect(host.catalog).toBe(f.resources.catalog);
    expect(host.naxPlugins).toBe(f.resources.naxPlugins);
  });
  test("AC-21 close tears down exactly once after release", async () => {
    const f = fixture();
    const host = f.build();
    await host.start({ mode: "guarded", model: "test/model" });
    await Promise.all([host.close(), host.close()]);
    await host.close();
    expect(f.events).toEqual(["close", "release", "teardown"]);
    expect(f.resources.teardown).toHaveBeenCalledTimes(1);
  });
  test("AC-22/23 no resources exposes no catalog and only rule handlers", async () => {
    const f = fixture();
    const host = f.build(false);
    await host.start({ mode: "guarded", model: "test/model" });
    expect(host.catalog).toBeUndefined();
    expect(host.naxPlugins).toBeUndefined();
    expect(f.open.mock.calls[0]?.[0].loopHandlers.map((entry) => entry.event)).toEqual(
      createRuleDeliveryHandlers({ repoRoot: "/r", overrideMode: "merge" }).map((entry) => entry.event),
    );
  });
  test.each([false, true])("AC-20/24 real opener forwards providers only when present: %s", async (withResources) => {
    const f = fixture();
    const backend = mock((_options: Parameters<typeof _openChatSessionDeps.nativeBackend>[0]) => ({
      kind: "native",
      open: async () => {
        throw new Error("unused");
      },
    }));
    _openChatSessionDeps.nativeBackend = backend;
    _openChatSessionDeps.createAgentSession = mock(async () => f.session);
    _openChatSessionDeps.createFileTranscriptStore = () => ({
      load: async () => null,
      save: async () => {},
      delete: async () => {},
      retainFailed: async () => {},
      markTurn: async () => {},
    });
    _openChatSessionDeps.resolveRuleSet = async () => ({
      rules: [],
      repoRulesTotal: 0,
      repoRulesMatchedPaths: 0,
      packageRulesCount: 0,
    });
    if (withResources) {
      await f.build(true, false).start({ mode: "guarded", model: "test/model" });
      expect(_openChatSessionDeps.nativeBackend).toHaveBeenCalledWith(
        expect.objectContaining({ toolProviders: f.resources.toolProviders }),
      );
    } else {
      const handle = await openChatSession({ ...f.deps, model: "test/model", loopHandlers: [] });
      await handle.session.close();
      await handle.release();
      const call = backend.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(call).not.toHaveProperty("toolProviders");
    }
  });
});
