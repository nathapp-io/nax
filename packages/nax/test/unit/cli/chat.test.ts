import { describe, expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { createSessionStorage } from "@nathapp/nax-agent";
import { makeInteractionChain, makeLogger, makeNaxConfig, withTempDir } from "@test/helpers";
import chalk from "chalk";
import { Command } from "commander";
import { type ChatHostState, type ChatMcp, createChatHost, createChatStorage } from "@/chat";
import { registerStatusCommand } from "@/cli/status-dispatch";
import { NaxError } from "@/errors";
import { PluginRegistry } from "@/plugins";
import { buildResourceCatalog } from "@/resources";
import { resolveChatTheme } from "@/tui/chat";
import { NAX_VERSION } from "@/version";

async function fixture() {
  const api = await import("@/cli/chat");
  const config = structuredClone(makeNaxConfig({ models: { native: { balanced: "openai/gpt-6" } } }));
  const logger = makeLogger();
  const storage = createChatStorage({ pid: process.pid, now: () => new Date(), logger });
  const host = Object.assign(
    createChatHost({ config, storage, cwd: "/repo", repoRoot: "/repo", chain: null, now: () => new Date(), logger }),
    {
      start: mock(async (_input: Parameters<ReturnType<typeof createChatHost>["start"]>[0]) => {}),
      resume: mock(async (_input: { id?: string }) => {}),
      switchTo: mock(async (_input: Parameters<ReturnType<typeof createChatHost>["switchTo"]>[0]) => {}),
      close: mock(async () => {}),
    },
  );
  const handlers = new Map<string, () => Promise<void>>();
  const removed: string[] = [];
  const rendered = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let keepOpen = false;
  const shell = {
    unmount: mock(() => exited.resolve()),
    waitUntilExit: () => (keepOpen ? exited.promise : Promise.resolve()),
  };
  const deps = {
    ...api._chatCommandDeps,
    collectAuthList: mock(
      async (_ids: readonly string[]): Promise<import("@/cli/auth-list").AuthListReport> => ({
        source: "file",
        providers: [],
      }),
    ),
    listCatalogModels: mock(async (_ids: readonly string[]): Promise<readonly string[]> => []),
    stdinIsTTY: () => true,
    ensureTrusted: async () => {},
    loadPlugins: async () => new PluginRegistry([]),
    loadResourceCatalog: async () => buildResourceCatalog([]),
    createChatMcp: async (..._args: Parameters<typeof api._chatCommandDeps.createChatMcp>): Promise<ChatMcp> => ({
      state: { servers: [], diagnostics: [], events: () => [], withheld: () => [] },
      providers: [],
      close: async () => {},
    }),
    env: { CLAUDE_CONFIG_DIR: "/nonexistent-claude" },
    loadConfig: mock(async (..._args: Parameters<typeof api._chatCommandDeps.loadConfig>) => config),
    findProjectDir: mock((_dir: string): string | null => "/repo/.nax"),
    initInteractionChain: mock(
      async (
        ..._args: Parameters<typeof api._chatCommandDeps.initInteractionChain>
      ): Promise<ReturnType<typeof makeInteractionChain> | null> => null,
    ),
    createChatStorage: mock(() => storage),
    createChatHost: mock((_input: Parameters<typeof createChatHost>[0]) => host),
    renderChat: mock((_props: Parameters<typeof api._chatCommandDeps.renderChat>[0]) => {
      rendered.resolve();
      return shell;
    }),
    onSignal: (signal: "SIGTERM" | "SIGHUP", handler: () => Promise<void>) => {
      handlers.set(signal, handler);
      return () => {
        removed.push(signal);
        handlers.delete(signal);
      };
    },
    writeErr: mock((_text: string) => {}),
    writeOut: mock((_message: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return {
    ...api,
    deps,
    host,
    config,
    handlers,
    removed,
    rendered,
    shell,
    stayOpen: () => {
      keepOpen = true;
    },
  };
}

const EXIT_STATE: ChatHostState = {
  sessionId: "abc123",
  mode: "guarded",
  model: "openai/gpt-6",
  meta: {
    schemaVersion: 1,
    sessionId: "abc123",
    cwd: "/repo",
    mode: "ask",
    model: "openai/gpt-6",
    bashApproval: "gated",
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    costUsd: 0.875,
  },
};
const EXIT_SUMMARY = "✻ nax chat session abc123 · $0.88\n  resume with: nax chat --resume abc123";

describe("chatCommand", () => {
  test("AC-1/19: non-TTY refuses before opening any session", async () => {
    const f = await fixture();
    f.deps.stdinIsTTY = () => false;
    await f.chatCommand({}, f.deps);
    expect(f.deps.writeErr).toHaveBeenCalledWith("nax chat needs an interactive terminal");
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
    expect(f.deps.createChatHost).not.toHaveBeenCalled();
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.host.resume).not.toHaveBeenCalled();
    expect(f.deps.loadConfig).not.toHaveBeenCalled();
  });
  test.each(["full", "guarded"] as const)("AC-2/3: starts %s and renders the host", async (mode) => {
    const f = await fixture();
    await f.chatCommand(mode === "full" ? { mode } : {}, f.deps);
    expect(f.host.start).toHaveBeenCalledWith({ mode, model: "openai/gpt-6" });
    expect(f.deps.renderChat).toHaveBeenCalledWith(expect.objectContaining({ host: f.host }));
  });
  test("AC-4: rejects an invalid mode without constructing a host", async () => {
    const f = await fixture();
    await f.chatCommand({ mode: "auto" }, f.deps);
    expect(f.deps.writeErr).toHaveBeenCalledWith("unknown mode auto; expected full or guarded");
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
    expect(f.deps.createChatHost).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-5", {}, "openai/gpt-6"],
    ["AC-6", { model: "anthropic/claude-sonnet-5-5" }, "anthropic/claude-sonnet-5-5"],
  ] as const)("%s: resolves launch model", async (_ac, options, model) => {
    const f = await fixture();
    await f.chatCommand(options, f.deps);
    expect(f.host.start).toHaveBeenCalledWith({ mode: "guarded", model });
  });
  test.each([
    [true, {}],
    ["abc", { id: "abc" }],
  ] as const)("AC-7/8: resume %s preserves stored settings", async (resume, expected) => {
    const f = await fixture();
    await f.chatCommand({ resume }, f.deps);
    expect(f.host.resume).toHaveBeenCalledWith(expected);
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.host.switchTo).not.toHaveBeenCalled();
  });
  test("AC-9: passes nonempty profile overrides", async () => {
    const f = await fixture();
    await f.chatCommand({ profile: ["fast"] }, f.deps);
    expect(f.deps.loadConfig).toHaveBeenCalledWith("/repo/.nax", { profile: ["fast"] });
  });
  test("AC-10: cwd remains the launch directory while repoRoot is discovered", async () => {
    const f = await fixture();
    await f.chatCommand({ dir: "/repo/sub" }, f.deps);
    expect(f.deps.findProjectDir).toHaveBeenCalledWith("/repo/sub");
    expect(f.deps.createChatHost).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/sub", repoRoot: "/repo" }),
    );
  });
  test("US-020 AC-6: renders the screen with the launch directory, build and terminal theme", async () => {
    const f = await fixture();
    await f.chatCommand({ dir: "/repo/sub" }, f.deps);
    expect(f.deps.renderChat).toHaveBeenCalledWith(
      expect.objectContaining({
        host: f.host,
        cwd: "/repo/sub",
        version: NAX_VERSION,
        home: homedir(),
        theme: resolveChatTheme({ env: f.deps.env, colorLevel: chalk.level }),
      }),
    );
  });
  test("AC-11: locked resume reports the exact message and never renders", async () => {
    const f = await fixture();
    f.host.resume.mockRejectedValue(
      new NaxError("session abc is in use by pid 4242", "CHAT_SESSION_LOCKED", { stage: "chat" }),
    );
    await f.chatCommand({ resume: "abc" }, f.deps);
    expect(f.deps.writeErr).toHaveBeenCalledWith("session abc is in use by pid 4242");
    expect(f.deps.renderChat).not.toHaveBeenCalled();
    expect(f.host.close).toHaveBeenCalled();
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
  });
  test("AC-12: composes the shared store and headless chain", async () => {
    const f = await fixture();
    const chain = makeInteractionChain();
    f.deps.initInteractionChain.mockResolvedValue(chain);
    await f.chatCommand({}, f.deps);
    expect(f.deps.initInteractionChain).toHaveBeenCalledWith(f.config, true);
    expect(f.deps.createChatHost).toHaveBeenCalledWith(
      expect.objectContaining({ chain, storage: f.deps.createChatStorage.mock.results[0]?.value }),
    );
  });
  test("AC-13: unavailable chain warns and keeps asks local", async () => {
    const f = await fixture();
    f.deps.initInteractionChain.mockRejectedValue(new Error("bad token"));
    await f.chatCommand({}, f.deps);
    expect(f.deps.writeErr).toHaveBeenCalledWith("interaction chain unavailable: bad token; asks stay in the terminal");
    expect(f.deps.createChatHost).toHaveBeenCalledWith(expect.objectContaining({ chain: null }));
    expect(f.deps.renderChat).toHaveBeenCalled();
  });
  test.each(["SIGTERM", "SIGHUP"] as const)(
    "AC-14/20/21: %s awaits lock release before terminal teardown/exit",
    async (signal) => {
      const f = await fixture();
      f.stayOpen();
      const release = Promise.withResolvers<void>();
      let locked = true;
      f.host.close.mockImplementation(async () => {
        await release.promise;
        locked = false;
      });
      const running = f.chatCommand({}, f.deps);
      await f.rendered.promise;
      const handler = f.handlers.get(signal);
      expect(handler).toBeDefined();
      if (!handler) throw new Error("missing handler");
      const closing = handler();
      expect(f.host.close).toHaveBeenCalled();
      expect(locked).toBe(true);
      expect(f.shell.unmount).not.toHaveBeenCalled();
      expect(f.deps.setExitCode).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      await running;
      expect(locked).toBe(false);
      expect(f.shell.unmount).toHaveBeenCalled();
      expect(f.deps.setExitCode).toHaveBeenCalledWith(signal === "SIGTERM" ? 143 : 129);
      expect(f.removed.sort((a, b) => a.localeCompare(b))).toEqual(["SIGHUP", "SIGTERM"]);
    },
  );
  test.each(["SIGTERM", "SIGHUP"] as const)("AC-21: %s releases a real store lock", async (signal) => {
    await withTempDir(async (dir) => {
      const f = await fixture();
      f.stayOpen();
      const logger = makeLogger();
      const storage = createSessionStorage({ dir, pid: process.pid, now: () => new Date(), logger });
      const host = createChatHost({
        config: f.config,
        storage,
        cwd: dir,
        repoRoot: dir,
        chain: null,
        now: () => new Date(),
        logger,
        open: async () => ({
          release: await storage.acquireLock("cli-lock"),
          meta: {
            schemaVersion: 1,
            sessionId: "cli-lock",
            cwd: dir,
            mode: "ask",
            model: "openai/gpt-6",
            bashApproval: "raw",
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: null,
          },
          session: {
            id: "cli-lock",
            backend: { kind: "native", capabilities: {} },
            lastTurn: undefined,
            async *send() {},
            answer: () => "accepted",
            cancel: () => {},
            close: async () => {},
          },
        }),
      });
      const running = f.chatCommand({}, { ...f.deps, createChatHost: () => host });
      try {
        await f.rendered.promise;
        expect(await storage.readLockHolder("cli-lock")).toMatchObject({ state: "own" });
        const handler = f.handlers.get(signal);
        if (!handler) throw new Error("missing signal handler");
        await handler();
        await running;
        expect(await storage.readLockHolder("cli-lock")).toBeNull();
      } finally {
        await host.close();
        f.shell.unmount();
        await running;
      }
    });
  });
  test("AC-8/9: a normal exit writes the summary once, after the shell unmounts", async () => {
    const f = await fixture();
    let unmountsAtWrite = -1;
    f.host.current = () => EXIT_STATE;
    f.deps.writeOut.mockImplementation(() => {
      unmountsAtWrite = f.shell.unmount.mock.calls.length;
    });
    await f.chatCommand({}, f.deps);
    expect(f.deps.writeOut).toHaveBeenCalledTimes(1);
    expect(f.deps.writeOut).toHaveBeenCalledWith(EXIT_SUMMARY);
    expect(unmountsAtWrite).toBe(1);
  });
  test("AC-10: a signal shutdown writes the summary once", async () => {
    const f = await fixture();
    f.stayOpen();
    f.host.current = () => EXIT_STATE;
    const running = f.chatCommand({}, f.deps);
    await f.rendered.promise;
    const handler = f.handlers.get("SIGTERM");
    if (!handler) throw new Error("missing signal handler");
    await handler();
    await running;
    expect(f.deps.writeOut).toHaveBeenCalledTimes(1);
    expect(f.deps.writeOut).toHaveBeenCalledWith(EXIT_SUMMARY);
  });
  test("AC-11/12: an unreadable host state writes no summary and leaves the exit code alone", async () => {
    const f = await fixture();
    f.stayOpen();
    f.host.current = () => {
      throw new Error("no session is open");
    };
    const running = f.chatCommand({}, f.deps);
    await f.rendered.promise;
    const handler = f.handlers.get("SIGTERM");
    if (!handler) throw new Error("missing signal handler");
    await handler();
    await running;
    expect(f.deps.writeOut).not.toHaveBeenCalled();
    expect(f.deps.setExitCode).toHaveBeenCalledTimes(1);
    expect(f.deps.setExitCode).toHaveBeenCalledWith(143);
  });
  test("applies only explicit resume switches", async () => {
    const f = await fixture();
    await f.chatCommand({ resume: true, mode: "full", model: "openai/other" }, f.deps);
    expect(f.host.resume).toHaveBeenCalledWith({});
    expect(f.host.switchTo).toHaveBeenCalledWith({ mode: "full", model: "openai/other" });
  });
  test("object model entries and missing project resolve at the boundary", async () => {
    const f = await fixture();
    f.config.models.native = { balanced: { provider: "openai", model: "gpt-6" } };
    f.deps.findProjectDir.mockReturnValue(null);
    await f.chatCommand({ dir: "/repo", profile: [] }, f.deps);
    expect(f.host.start).toHaveBeenCalledWith({ mode: "guarded", model: "openai/gpt-6" });
    expect(f.deps.loadConfig).toHaveBeenCalledWith(undefined);
    expect(f.deps.createChatHost).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", repoRoot: "/repo" }));
  });
  test("startup failure closes resources without installing signals", async () => {
    const f = await fixture();
    f.host.start.mockRejectedValue(new Error("start failed"));
    await f.chatCommand({}, f.deps);
    expect(f.host.close).toHaveBeenCalledTimes(1);
    expect(f.deps.renderChat).not.toHaveBeenCalled();
    expect(f.handlers.size).toBe(0);
    expect(f.deps.writeErr).toHaveBeenCalledWith("start failed");
  });
  test("host construction failure destroys the unowned interaction chain", async () => {
    const f = await fixture();
    const destroy = mock(async () => {});
    f.deps.initInteractionChain.mockResolvedValue(makeInteractionChain({ destroy }));
    f.deps.createChatHost.mockImplementation(() => {
      throw new Error("construction failed");
    });
    await f.chatCommand({}, f.deps);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(f.deps.writeErr).toHaveBeenCalledWith("construction failed");
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
  });
  test("config failure opens no host", async () => {
    const f = await fixture();
    f.deps.loadConfig.mockRejectedValue(new Error("config failed"));
    await f.chatCommand({}, f.deps);
    expect(f.deps.createChatHost).not.toHaveBeenCalled();
    expect(f.deps.writeErr).toHaveBeenCalledWith("config failed");
  });
  test("render failure closes the host and removes signals", async () => {
    const f = await fixture();
    f.deps.renderChat.mockImplementation(() => {
      throw new Error("render failed");
    });
    await f.chatCommand({}, f.deps);
    expect(f.host.close).toHaveBeenCalled();
    expect(f.deps.writeErr).toHaveBeenCalledWith("render failed");
    expect(f.handlers.size).toBe(0);
  });
});

describe("registerChatCommand", () => {
  test.each([
    ["AC-15", [], "guarded"],
    ["AC-16", ["chat", "--mode", "full"], "full"],
  ] as const)("%s: routes to chat", async (_ac, args, mode) => {
    const f = await fixture();
    const program = new Command().exitOverride();
    f.registerChatCommand(program, f.deps);
    await program.parseAsync([...args], { from: "user" });
    expect(f.host.start).toHaveBeenCalledWith({ mode, model: "openai/gpt-6" });
  });
  test("AC-17: rejects typos as excess arguments without opening chat", async () => {
    const f = await fixture();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    f.registerChatCommand(program, f.deps);
    await expect(program.parseAsync(["rnu"], { from: "user" })).rejects.toMatchObject({
      code: "commander.excessArguments",
    });
    expect(f.deps.createChatHost).not.toHaveBeenCalled();
  });
  test("AC-22: existing status dispatch is not intercepted", async () => {
    const f = await fixture();
    const dispatchStatusView = mock(async () => {});
    const program = new Command().exitOverride();
    f.registerChatCommand(program, f.deps);
    registerStatusCommand(program, {
      validateDirectory: (dir) => dir,
      findProjectDir: () => "/repo/.nax",
      dispatchStatusView,
    });
    await program.parseAsync(["status", "--dir", "/repo"], { from: "user" });
    expect(dispatchStatusView).toHaveBeenCalledWith("/repo", expect.objectContaining({ cost: false }));
    expect(f.deps.createChatHost).not.toHaveBeenCalled();
  });
  test("collects repeatable profiles and forwards dir, model and resume", async () => {
    const f = await fixture();
    const program = new Command().exitOverride();
    f.registerChatCommand(program, f.deps);
    await program.parseAsync(
      ["chat", "--profile", "a", "--profile", "b", "-d", "/repo", "--model", "openai/other", "--resume", "abc"],
      { from: "user" },
    );
    expect(f.deps.loadConfig).toHaveBeenCalledWith("/repo/.nax", { profile: ["a", "b"] });
    expect(f.host.resume).toHaveBeenCalledWith({ id: "abc" });
    expect(f.host.switchTo).toHaveBeenCalledWith({ model: "openai/other" });
  });
  // Story-required smoke exception to the general no-full-CLI-spawn rule; help opens no session.
  test("AC-18: bin registers chat help", async () => {
    const proc = Bun.spawn(["bun", "bin/nax.ts", "chat", "--help"], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("--mode <full|guarded>");
  }, 30_000);
});

describe("chatCommand model discovery", () => {
  test("US-006 AC-12/13/14 requests configured providers and uses only available catalog providers", async () => {
    const f = await fixture();
    f.config.models.native = { fast: { provider: "p1", model: "m1" }, balanced: "p1/m1", powerful: "p2/m2" };
    f.config.agent = {
      ...f.config.agent,
      native: {
        ...f.config.agent?.native,
        catalogOverrides: [
          {
            provider: "local",
            models: [
              {
                id: "x",
                supportsTools: true,
                protocol: "openai-completions",
                contextWindow: 1000,
                thinkingLevels: [],
                pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      },
    };
    f.deps.collectAuthList.mockResolvedValue({
      source: "file",
      providers: [
        { providerId: "p1", available: true, stored: null, ambient: true },
        { providerId: "p2", available: false, stored: null, ambient: false },
      ],
    });
    f.deps.listCatalogModels.mockResolvedValue(["p1/m1", "p1/m3"]);
    await f.chatCommand({}, f.deps);
    expect(f.deps.collectAuthList).toHaveBeenCalledWith(["p1", "p2", "local"]);
    expect(f.deps.listCatalogModels).toHaveBeenCalledWith(["p1"]);
    expect(f.deps.createChatHost).toHaveBeenCalledWith(
      expect.objectContaining({ models: ["p1/m1", "p2/m2", "local/x", "p1/m3"] }),
    );
  });
  test("US-006 AC-14 no overrides: tiers precede deduplicated catalog models", async () => {
    const f = await fixture();
    f.config.models.native = { balanced: "openai/gpt-6" };
    f.deps.listCatalogModels.mockResolvedValue(["openai/gpt-6", "p1/m3"]);
    await f.chatCommand({}, f.deps);
    expect(f.deps.createChatHost).toHaveBeenCalledWith(expect.objectContaining({ models: ["openai/gpt-6", "p1/m3"] }));
  });
  test.each([false, true])("US-006 AC-15/18 auth rejection preserves tiers and overrides=%s", async (override) => {
    const f = await fixture();
    f.config.models.native = { fast: "p1/m1", balanced: "p1/m1" };
    if (override)
      f.config.agent = {
        ...f.config.agent,
        native: {
          ...f.config.agent?.native,
          catalogOverrides: [
            {
              provider: "local",
              models: [
                {
                  id: "x",
                  supportsTools: true,
                  protocol: "openai-completions",
                  contextWindow: 1000,
                  thinkingLevels: [],
                  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          ],
        },
      };
    f.deps.collectAuthList.mockRejectedValue(new Error("offline"));
    await f.chatCommand({}, f.deps);
    expect(f.deps.listCatalogModels).toHaveBeenCalledWith([]);
    expect(f.deps.createChatHost).toHaveBeenCalledWith(
      expect.objectContaining({ models: override ? ["p1/m1", "local/x"] : ["p1/m1"] }),
    );
    expect(f.deps.setExitCode).not.toHaveBeenCalled();
  });
});
