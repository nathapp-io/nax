import { describe, expect, mock, test } from "bun:test";
import { join, resolve } from "node:path";
import { makeLogger, makeNaxConfig, withTempDir } from "@test/helpers";
import { createChatHost, createChatStorage } from "@/chat";
import { _chatCommandDeps, chatCommand } from "@/cli/chat";
import { globalConfigDir } from "@/config";
import { NaxError } from "@/errors";
import { PluginRegistry } from "@/plugins";
import { buildResourceCatalog, loadResourceCatalog } from "@/resources";

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
    initInteractionChain: async () => null,
    createChatStorage: () => storage,
    createChatHost: mock((_input: Parameters<typeof createChatHost>[0]) => host),
    renderChat: () => ({ unmount() {}, waitUntilExit: async () => {} }),
    onSignal: () => () => {},
    writeErr: mock((_message: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return { deps, order };
}

describe("chatCommand resources and trust", () => {
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
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = join(dir, "empty-claude");
      try {
        await chatCommand({ dir }, deps);
        expect(deps.createChatHost.mock.calls[0]?.[0].resources?.catalog.findSkill("kit-skill")?.origin).toEqual({
          kind: "nax-plugin",
          plugin: "kit",
        });
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  });
});
