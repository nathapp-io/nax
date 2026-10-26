import { afterEach, describe, expect, mock, test } from "bun:test";
import { CHAT_MODEL, makeAgentResource, makeSubagentHostHarness } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import type { ChatHost, ChatHostState, ChatMcpState } from "@/chat";
import { formatMcpListing } from "@/chat";
import { featureDir } from "@/config";
import { buildChatFeatureMessage } from "@/prompts";
import { buildResourceCatalog, formatPluginsListing, formatSkillsListing, type SkillResource } from "@/resources";
import { ChatApp } from "@/tui/chat";
import { COMMAND_DESCRIPTIONS, COMMANDS } from "@/tui/chat/slash-commands";

afterEach(() => {
  cleanup();
  mock.restore();
});
function mount() {
  const state: ChatHostState = {
    sessionId: "old-session",
    mode: "guarded",
    model: "old-model",
    meta: {
      schemaVersion: 1,
      sessionId: "old-session",
      cwd: "/repo",
      mode: "ask",
      model: "old-model",
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 1.236,
    },
  };
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, _listener: Parameters<ChatHost["send"]>[1]) => {
    await gate.promise;
  });
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["model-one", "model-two"],
    asks: {
      pending: () => [],
      canRemember: () => false,
      resolve: () => {},
      setMode: () => {},
      reset: () => {},
      handle: () => {},
      answerQuestion: () => {},
      onChange: () => () => {},
    },
    current: () => state,
    notice: () => undefined,
    send,
    start: mock(async () => {}),
    clear: mock(async () => {}),
    resume: mock(async (_input: { id?: string }) => {}),
    switchTo: mock(async (_input: { mode?: "full" | "guarded"; model?: string }) => {}),
    cancel: mock(() => {}),
    close: mock(async () => {}),
    listSessions: mock(async () => [
      { sessionId: "abc", title: "first title", updatedAt: null, heldByPid: 4242 },
      { sessionId: "def", title: "second title", updatedAt: null },
    ]),
  };
  const ui = render(<ChatApp host={host} />);
  const type = (text: string) =>
    act(() => {
      ui.stdin.write(text);
    });
  const line = async (text: string) => {
    type(text);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write("\r");
      }),
    );
  };
  return { ...ui, host, send, line, type, finish: () => gate.resolve() };
}
describe("parseSlashCommand", () => {
  test("AC-1 returns name, arguments and raw rest", async () => {
    const { parseSlashCommand } = await import("@/tui/chat/slash-commands");
    expect(parseSlashCommand("/mode full")).toEqual({ name: "mode", args: ["full"], rest: " full" });
    expect(parseSlashCommand("/feature auth go  now")?.rest).toBe(" auth go  now");
  });
  test("AC-2 ordinary messages are not commands", async () => {
    const { parseSlashCommand } = await import("@/tui/chat/slash-commands");
    expect(parseSlashCommand("hello")).toBeNull();
  });
});
describe("slash command routing", () => {
  test("AC-3 switches mode", async () => {
    const ui = mount();
    await ui.line("/mode full");
    expect(ui.host.switchTo).toHaveBeenCalledWith({ mode: "full" });
  });
  test.each([...COMMANDS, "unknown", "", "feature missing"])("AC-4 never sends original /%s", async (command) => {
    const ui = mount();
    await ui.line(`/${command}`);
    expect(ui.send).not.toHaveBeenCalled();
  });
  test("AC-5 reports current mode in transcript", async () => {
    const ui = mount();
    await ui.line("/mode");
    expect(ui.lastFrame()).toContain("guarded\n");
  });
  test("AC-6 rejects an invalid mode", async () => {
    const ui = mount();
    await ui.line("/mode bogus");
    expect(ui.lastFrame()).toContain("unknown mode bogus; expected full or guarded");
    expect(ui.host.switchTo).not.toHaveBeenCalled();
  });
  test("AC-7 switches explicit model", async () => {
    const ui = mount();
    await ui.line("/model anthropic/claude-sonnet-5-5");
    expect(ui.host.switchTo).toHaveBeenCalledWith({ model: "anthropic/claude-sonnet-5-5" });
  });
  test("AC-8 lists all configured models", async () => {
    const ui = mount();
    await ui.line("/model");
    for (const model of ui.host.models) expect(ui.lastFrame()).toContain(model);
  });
  test("AC-9 AC-10 lists session ids, titles and live holders", async () => {
    const ui = mount();
    await ui.line("/sessions");
    for (const text of ["abc", "first title", "def", "second title", "in use by pid 4242"])
      expect(ui.lastFrame()).toContain(text);
  });
  test("AC-11 resumes explicit id", async () => {
    const ui = mount();
    await ui.line("/resume abc");
    expect(ui.host.resume).toHaveBeenCalledWith({ id: "abc" });
  });
  test("AC-12 clears session", async () => {
    const ui = mount();
    await ui.line("/clear");
    expect(ui.host.clear).toHaveBeenCalledTimes(1);
  });
  test("AC-13 reports rounded spend in transcript", async () => {
    const ui = mount();
    await ui.line("/cost");
    expect(ui.lastFrame()).toContain("$1.24\n");
  });
  test("AC-16 US-024 AC-14 help lists every command with its description", async () => {
    const ui = mount();
    await ui.line("/help");
    expect(ui.host.catalog).toBeUndefined();
    expect(ui.host.resourceNotice).toBeUndefined();
    expect(ui.lastFrame()).toContain(COMMANDS.map((name) => `/${name}  ${COMMAND_DESCRIPTIONS[name]}`).join("\n"));
  });
  test("US-008 AC-21 US-024 AC-14 help lists /mcp on the line after /plugins", async () => {
    const ui = mount();
    await ui.line("/help");
    expect(ui.lastFrame()).toContain("/plugins  List plugins and what they provide\n/mcp  List MCP servers");
  });
  test("AC-17 closes and exits", async () => {
    const ui = mount();
    await ui.line("/quit");
    expect(ui.host.close).toHaveBeenCalledTimes(1);
    await ui.line("hello");
    expect(ui.send).not.toHaveBeenCalled();
  });
  test("AC-18 unknown command notice", async () => {
    const ui = mount();
    await ui.line("/unknown");
    expect(ui.lastFrame()).toContain("unknown command /unknown");
  });
  test.each(COMMANDS.filter((name) => name !== "quit"))("AC-19 blocks /%s during turn", async (name) => {
    const ui = mount();
    await ui.line("hello");
    await ui.line(`/${name}`);
    expect(ui.lastFrame()).toContain("wait for the turn to finish (Ctrl-C to interrupt)");
    expect(ui.host.clear).not.toHaveBeenCalled();
    expect(ui.host.switchTo).not.toHaveBeenCalled();
    expect(ui.host.resume).not.toHaveBeenCalled();
    expect(ui.host.listSessions).not.toHaveBeenCalled();
    expect(ui.send).toHaveBeenCalledTimes(1);
    await Promise.resolve(act(async () => ui.finish()));
  });
  test("AC-20 cancels before close during turn", async () => {
    const ui = mount();
    const order: string[] = [];
    ui.host.cancel = mock(() => {
      order.push("cancel");
    });
    ui.host.close = mock(async () => {
      order.push("close");
    });
    await ui.line("hello");
    await ui.line("/quit");
    expect(order).toEqual(["cancel", "close"]);
    await Promise.resolve(act(async () => ui.finish()));
  });
  test.each(["clear", "resume"] as const)("AC-23 shows rejected /%s without closing old session", async (name) => {
    const ui = mount();
    ui.host[name] = mock(async () => {
      throw new Error("opening failed");
    });
    const previous = ui.host.current();
    await ui.line(`/${name} abc`);
    expect(ui.lastFrame()).toContain("opening failed");
    expect(ui.host.current()).toBe(previous);
    expect(ui.host.close).not.toHaveBeenCalled();
    await ui.line("still open");
    expect(ui.send).toHaveBeenCalledWith("still open", expect.any(Function));
    await Promise.resolve(act(async () => ui.finish()));
  });
});
describe("resource listings", () => {
  test.each(["skills", "plugins"] as const)(
    "US-015 AC-7/8/9/10 /%s displays local catalog without sending",
    async (name) => {
      const ui = mount();
      const skill: SkillResource = {
        kind: "skill",
        name: "demo",
        qualifiedName: "demo",
        description: "",
        body: "",
        baseDir: "/s",
        path: "/s/SKILL.md",
        modelInvocable: true,
        origin: { kind: "claude-project" },
      };
      const catalog = buildResourceCatalog([
        {
          id: "project",
          origin: skill.origin,
          root: "/s",
          skills: [skill],
          commands: [],
          agents: [],
          mcpServers: [],
          hooks: [],
          diagnostics: [],
        },
      ]);
      const naxPlugins: NonNullable<ChatHost["naxPlugins"]> = [{ name: "kit", provides: ["resources"] }];
      Object.assign(ui.host, { catalog, naxPlugins });
      await ui.line(`/${name}`);
      const expected = name === "skills" ? formatSkillsListing(catalog) : formatPluginsListing(catalog, naxPlugins);
      expect(ui.lastFrame()).toContain(expected);
      expect(ui.send).not.toHaveBeenCalled();
    },
  );
});
describe("mcp command", () => {
  const mcp: ChatMcpState = {
    servers: [{ id: "docs", source: "user", transport: "stdio", locked: true }],
    diagnostics: [],
    events: () => [],
    withheld: () => [],
  };
  test("US-008 AC-19 shows the listing of host.mcp", async () => {
    const { runSlashCommand } = await import("@/tui/chat/slash-commands");
    const ui = mount();
    const show = mock((_text: string) => {});
    const outcome = await runSlashCommand(
      { name: "mcp", args: [], rest: "" },
      { host: Object.assign(ui.host, { mcp }), show },
    );
    expect(outcome).toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toBe(formatMcpListing(mcp));
    expect(show.mock.calls[0]?.[0]).toContain("docs");
  });
  test("US-008 AC-20 shows (no MCP servers) when the host has no mcp", async () => {
    const { runSlashCommand } = await import("@/tui/chat/slash-commands");
    const ui = mount();
    const show = mock((_text: string) => {});
    await runSlashCommand({ name: "mcp", args: [], rest: "" }, { host: ui.host, show });
    expect(show).toHaveBeenCalledWith("(no MCP servers)");
  });
  test("/mcp displays in the transcript without sending", async () => {
    const ui = mount();
    Object.assign(ui.host, { mcp });
    await ui.line("/mcp");
    expect(ui.lastFrame()).toContain("docs  user  stdio  not connected");
    expect(ui.send).not.toHaveBeenCalled();
  });
});
describe("agents command", () => {
  test("US-011 AC-14 shows (no agents) when the host has no agents()", async () => {
    const { runSlashCommand } = await import("@/tui/chat/slash-commands");
    const ui = mount();
    const show = mock((_text: string) => {});
    expect(ui.host.agents).toBeUndefined();
    await runSlashCommand({ name: "agents", args: [], rest: "" }, { host: ui.host, show });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("(no agents)");
  });

  test("US-011 AC-15 US-024 AC-15 help lists /agents between /mcp and /quit", async () => {
    const ui = mount();
    await ui.line("/help");
    expect(ui.lastFrame()).toContain("/mcp  List MCP servers\n/agents  List agents\n/quit  Quit nax chat");
  });

  test("US-024 AC-16 help lists a catalog command with its hyphen description", async () => {
    const ui = mount();
    Object.assign(ui.host, {
      catalog: buildResourceCatalog([
        {
          id: "claude-project",
          origin: { kind: "claude-project" },
          root: "/repo",
          skills: [],
          agents: [],
          mcpServers: [],
          hooks: [],
          diagnostics: [],
          commands: [
            {
              kind: "command",
              name: "deploy",
              qualifiedName: "deploy",
              description: "Ship it",
              template: "Deploy $ARGUMENTS",
              path: "/repo/.claude/commands/deploy.md",
              origin: { kind: "claude-project" },
            },
          ],
        },
      ]),
    });
    await ui.line("/help");
    expect(ui.lastFrame()).toContain("/deploy - Ship it");
  });

  test("US-011 shows the listing of host.agents() in the transcript without sending", async () => {
    const ui = mount();
    ui.host.agents = () => [
      { name: "reviewer", description: "Reviews diffs", model: "a/s", modelSource: "alias", tools: "all", dropped: [] },
    ];
    await ui.line("/agents");
    expect(ui.lastFrame()).toContain("reviewer  a/s (alias)  tools all  Reviews diffs");
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("US-011 AC-13 a native host built by createChatHost lists its catalog agent first-line-first", async () => {
    const { runSlashCommand } = await import("@/tui/chat/slash-commands");
    const harness = makeSubagentHostHarness({ agents: [makeAgentResource({ name: "reviewer" })] });
    try {
      await harness.host.start({ mode: "guarded", model: CHAT_MODEL });
      const show = mock((_text: string) => {});
      await runSlashCommand({ name: "agents", args: [], rest: "" }, { host: harness.host, show });
      expect(show).toHaveBeenCalledTimes(1);
      const text = show.mock.calls[0]?.[0] ?? "";
      expect(text.split("\n")[0]?.startsWith("reviewer")).toBe(true);
      expect(text).toContain(`${CHAT_MODEL} (inherit)`);
    } finally {
      await harness.dispose();
    }
  });
});
describe("feature command", () => {
  test("does not send a loaded feature after Ctrl-C closes the app", async () => {
    const { _slashCommandDeps } = await import("@/tui/chat/slash-commands");
    const original = _slashCommandDeps.readText;
    const gate = Promise.withResolvers<string | undefined>();
    _slashCommandDeps.readText = async () => gate.promise;
    try {
      const ui = mount();
      await ui.line("/feature auth");
      ui.type("\u0003");
      await Promise.resolve(
        act(async () => {
          gate.resolve("spec");
        }),
      );
      expect(ui.host.close).toHaveBeenCalledTimes(1);
      expect(ui.send).not.toHaveBeenCalled();
    } finally {
      _slashCommandDeps.readText = original;
    }
  });
  test("AC-15 missing feature names its directory", async () => {
    const { _slashCommandDeps } = await import("@/tui/chat/slash-commands");
    const original = _slashCommandDeps.readText;
    const read = mock(async (_path: string) => undefined);
    _slashCommandDeps.readText = read;
    try {
      const ui = mount();
      await ui.line("/feature missing");
      const dir = featureDir(ui.host.repoRoot, "missing");
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(`${dir}/spec.md`);
      expect(ui.lastFrame()).toContain(`no feature missing (looked in ${dir})`);
      expect(ui.send).not.toHaveBeenCalled();
    } finally {
      _slashCommandDeps.readText = original;
    }
  });
  test.each([
    ["AC-14", "spec text", '{"stories":[]}', "go  now"],
    ["AC-22", "spec only", undefined, ""],
    ["AC-15 AC-21", undefined, undefined, ""],
  ] as const)("%s loads repo feature artifacts and preserves personal spacing", async (_ac, spec, prd, message) => {
    const { _slashCommandDeps } = await import("@/tui/chat/slash-commands");
    const original = _slashCommandDeps.readText;
    const dir = featureDir("/repo", "auth");
    const read = mock(async (path: string) =>
      path === `${dir}/spec.md` ? spec : path === `${dir}/prd.json` ? prd : undefined,
    );
    _slashCommandDeps.readText = read;
    try {
      const ui = mount();
      await ui.line(`/feature auth${message ? ` ${message}` : ""}`);
      expect(read).toHaveBeenCalledWith(`${dir}/spec.md`);
      if (spec === undefined) {
        expect(ui.lastFrame()).toContain(`no feature auth (looked in ${dir})`);
        expect(ui.send).not.toHaveBeenCalled();
      } else {
        expect(read).toHaveBeenCalledWith(`${dir}/prd.json`);
        expect(ui.send).toHaveBeenCalledWith(
          buildChatFeatureMessage({ feature: "auth", spec, prd, message }),
          expect.any(Function),
        );
      }
      await Promise.resolve(act(async () => ui.finish()));
    } finally {
      _slashCommandDeps.readText = original;
    }
  });
});
