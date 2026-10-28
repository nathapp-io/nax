import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CommandRunResult, SessionEvent } from "@nathapp/nax-agent";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, createChatAskController } from "@/chat";
import { buildResourceCatalog, type ResourcePackage } from "@/resources";
import { ChatApp } from "@/tui/chat";
import { _slashCommandDeps } from "@/tui/chat/slash-commands";

const originalRead = _slashCommandDeps.readText;
afterEach(() => {
  cleanup();
  _slashCommandDeps.readText = originalRead;
});
function mount(run?: NonNullable<ChatHost["runCommand"]>) {
  const origin = { kind: "nax-plugin", plugin: "kit" } as const;
  const pkg: ResourcePackage = {
    id: "kit",
    root: "/kit",
    origin,
    agents: [],
    mcpServers: [],
    hooks: [],
    diagnostics: [],
    commands: [
      ["status-cmd", "Status: !`git status`"],
      ["say", "Say $ARGUMENTS"],
    ].map(([name = "", template = ""]) => ({
      kind: "command",
      name,
      qualifiedName: `kit:${name}`,
      template,
      origin,
      path: `/kit/${name}.md`,
    })),
    skills: [
      {
        kind: "skill",
        name: "skill",
        qualifiedName: "kit:skill",
        description: "literal",
        body: "!`echo x`",
        baseDir: "/kit/skill",
        path: "/kit/skill/SKILL.md",
        modelInvocable: true,
        origin,
      },
    ],
  };
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const resolve = mock(asks.resolve.bind(asks));
  asks.resolve = resolve;
  const send = mock<ChatHost["send"]>(async () => {});
  const cancel = mock(() => {});
  const close = mock(async () => {});
  const host: ChatHost = {
    repoRoot: "/repo",
    catalog: buildResourceCatalog([pkg]),
    models: ["model"],
    asks,
    current: () => ({
      sessionId: "s",
      mode: "guarded",
      model: "model",
      meta: {
        schemaVersion: 1,
        sessionId: "s",
        cwd: "/repo",
        mode: "ask",
        model: "model",
        bashApproval: "gated",
        title: null,
        createdAt: "now",
        updatedAt: null,
      },
    }),
    notice: () => undefined,
    send,
    cancel,
    close,
    ...(run ? { runCommand: run } : {}),
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
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
  return { ...ui, host, send, cancel, close, resolve, type, line };
}
const ok = async (): Promise<CommandRunResult> => ({ isError: false, content: "clean" });
describe("ChatApp command shell lines", () => {
  test("AC-13 expands a catalog template before sending", async () => {
    const order: string[] = [];
    const run = mock(async (command: string) => {
      order.push(command);
      return ok();
    });
    const ui = mount(run);
    ui.send.mockImplementation(async (message) => {
      order.push(message);
    });
    await ui.line("/status-cmd");
    expect(run).toHaveBeenCalledWith("git status", expect.any(Function));
    expect(ui.send).toHaveBeenCalledWith("Status: clean", expect.any(Function), { title: "/status-cmd" });
    expect(order).toEqual(["git status", "Status: clean"]);
  });
  test("AC-14 AC-15 failure shows a notice and never sends", async () => {
    const ui = mount(async () => ({ isError: true, content: "denied" }));
    await ui.line("/status-cmd");
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain("command /status-cmd not sent: !`git status` failed: denied");
    await ui.line("hello");
    expect(ui.send).toHaveBeenCalledWith("hello", expect.any(Function));
  });
  test("AC-16 AC-17 skill bodies remain literal", async () => {
    const run = mock(ok);
    const ui = mount(run);
    await ui.line("/skill");
    expect(ui.send.mock.calls[0]?.[0]).toContain("!`echo x`");
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-18 AC-19 user arguments remain literal", async () => {
    const run = mock(ok);
    const ui = mount(run);
    await ui.line("/say !`rm x`");
    expect(run).not.toHaveBeenCalled();
    expect(ui.send).toHaveBeenCalledWith("Say !`rm x`", expect.any(Function), { title: "/say !`rm x`" });
  });
  test("AC-20 AC-21 missing capability shows a notice and never sends", async () => {
    const ui = mount();
    await ui.line("/status-cmd");
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain("this session cannot run commands");
  });
  test.each(["approval", "cancel"] as const)("AC-22 AC-23 pending expansion permits %s", async (action) => {
    const gate = Promise.withResolvers<CommandRunResult>();
    const run = mock(async (_command: string, onEvent: (event: SessionEvent) => void) => {
      const event: SessionEvent = {
        sessionId: "s",
        turnId: "cmd",
        at: "now",
        metadata: {},
        type: "approval_requested",
        requestId: "ask-1",
        tool: "Bash",
        command: "git status",
        reason: "Approve status",
        summary: "status",
        expiresAt: "later",
      };
      ui.host.asks.handle(event);
      onEvent(event);
      return gate.promise;
    });
    const ui = mount(run);
    try {
      await ui.line("/status-cmd");
      expect(run).toHaveBeenCalledTimes(1);
      expect(ui.send).not.toHaveBeenCalled();
      expect(ui.lastFrame()).toContain("Approve status");
      if (action === "approval") {
        ui.type("a");
        expect(ui.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
      } else {
        ui.type("\x03");
        expect(ui.cancel).toHaveBeenCalledTimes(1);
        expect(ui.close).not.toHaveBeenCalled();
      }
    } finally {
      await Promise.resolve(
        act(async () => {
          gate.resolve({ isError: true, content: "cancelled" });
        }),
      );
    }
  });
  test("feature specs and ordinary user messages are never expanded", async () => {
    _slashCommandDeps.readText = async (path) => (path.endsWith("spec.md") ? "!`echo spec`" : undefined);
    const run = mock(ok);
    const ui = mount(run);
    await ui.line("/feature demo");
    expect(ui.send.mock.calls[0]?.[0]).toContain("!`echo spec`");
    await ui.line("!`echo user`");
    expect(ui.send).toHaveBeenLastCalledWith("!`echo user`", expect.any(Function));
    expect(run).not.toHaveBeenCalled();
  });
});
