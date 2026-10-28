import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, createChatAskController } from "@/chat";
import { buildResourceCatalog, type SkillResource } from "@/resources";
import { ChatApp } from "@/tui/chat";
import { fakeMouse } from "./mouse";

afterEach(cleanup);
const skill: SkillResource = {
  kind: "skill",
  name: "demo",
  qualifiedName: "kit:demo",
  description: "demo",
  body: "private skill body",
  baseDir: "/kit",
  path: "/kit/SKILL.md",
  modelInvocable: true,
  origin: { kind: "nax-plugin", plugin: "kit" },
};
const thoughts: SessionEventBody[] = [
  { type: "thinking_delta", round: 1, text: "first private thought" },
  { type: "text_delta", round: 1, text: "first reply" },
  { type: "thinking_delta", round: 2, text: "second private thought" },
  { type: "text_delta", round: 2, text: "second reply" },
];
const toolEvents: SessionEventBody[] = [
  {
    type: "tool_call",
    callId: "c",
    name: "Bash",
    input: { command: "echo a very long command with many arguments that must wrap across several rows" },
  },
  {
    type: "tool_result",
    callId: "c",
    isError: false,
    preview: "one\ntwo\nthree\nfour\nfive\nsix\nprivate tool output",
  },
];
async function mount(events: SessionEventBody[] = thoughts, width = 100) {
  const mouse = fakeMouse();
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["model"],
    catalog: buildResourceCatalog([
      {
        id: "kit",
        root: "/kit",
        origin: skill.origin,
        skills: [skill],
        commands: [],
        agents: [],
        mcpServers: [],
        hooks: [],
        diagnostics: [],
      },
    ]),
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
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
    send: async (_message, listener) => {
      for (const body of events)
        listener({ sessionId: "s", turnId: "t", at: "2026-01-01T00:00:00Z", metadata: {}, ...body });
    },
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    cancel: () => {},
    close: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} mouse={mouse.events} />);
  const key = async (text: string) => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
      }),
    );
  };
  Object.defineProperty(ui.stdout, "columns", { value: width, configurable: true });
  Object.defineProperty(ui.stdout, "rows", { value: 45, configurable: true });
  await Promise.resolve(
    act(async () => {
      ui.stdout.emit("resize");
    }),
  );
  const frame = () => ui.lastFrame() ?? "";
  const rows = () => frame().split("\n");
  const row = (text: string, occurrence = 0) => {
    const matches = rows().flatMap((line, index) => (line.includes(text) ? [index] : []));
    const index = matches[occurrence];
    expect(index).toBeDefined();
    if (index === undefined) throw new Error(`missing row ${text}`);
    return index;
  };
  const click = async (index: number) => {
    await Promise.resolve(
      act(async () => {
        mouse.emit("press", { button: "left", x: 2, y: index + 1 });
        mouse.emit("release", { button: "left", x: 2, y: index + 1 });
      }),
    );
  };
  const send = async (text = "hello") => {
    await key(text);
    await key("\r");
  };
  return { frame, rows, row, click, key, send };
}

describe("ChatApp transcript clicks", () => {
  test("AC-11/12 first thinking row opens then closes", async () => {
    const ui = await mount();
    await ui.send();
    expect(ui.frame()).not.toContain("first private thought");
    await ui.click(ui.row("Thought for"));
    expect(ui.frame()).toContain("first private thought");
    await ui.click(ui.row("Thought for"));
    expect(ui.frame()).not.toContain("first private thought");
  });
  test("AC-13/14 clicked override survives ctrl+o twice while others toggle", async () => {
    const ui = await mount();
    await ui.send();
    await ui.click(ui.row("Thought for"));
    expect(ui.frame()).toContain("first private thought");
    expect(ui.frame()).not.toContain("second private thought");
    await ui.key("\x0f");
    expect(ui.frame()).toContain("first private thought");
    expect(ui.frame()).toContain("second private thought");
    await ui.key("\x0f");
    expect(ui.frame()).toContain("first private thought");
    expect(ui.frame()).not.toContain("second private thought");
  });
  test("AC-15/16 skill hint opens and user row closes", async () => {
    const ui = await mount([]);
    await ui.send("/kit:demo");
    expect(ui.frame()).not.toContain(skill.body);
    await ui.click(ui.row("⎿  skill"));
    expect(ui.frame()).toContain(skill.body);
    await ui.click(ui.row("> /kit:demo"));
    expect(ui.frame()).not.toContain(skill.body);
  });
  test("AC-17 skill body click changes nothing", async () => {
    const ui = await mount([]);
    await ui.send("/kit:demo");
    await ui.key("\x0f");
    expect(ui.frame()).toContain(skill.body);
    const before = ui.frame();
    await ui.click(ui.row(skill.body));
    expect(ui.frame()).toBe(before);
  });
  test.each(["reply", "separator", "padding", "outside"])("AC-18/19/20/23 ignores %s", async (target) => {
    const ui = await mount();
    await ui.send();
    const first = ui.row("Thought for");
    const index =
      target === "reply"
        ? ui.row("first reply")
        : target === "separator"
          ? first - 1
          : target === "padding"
            ? ui.row("second reply") + 2
            : 0;
    if (target === "separator" || target === "padding") expect(ui.rows()[index]?.trim()).toBe("");
    const before = ui.frame();
    await ui.click(index);
    expect(ui.frame()).toBe(before);
  });
  test("wrapped thinking header and thought body are inert", async () => {
    const ui = await mount(
      [
        { type: "thinking_delta", round: 1, text: "secret" },
        { type: "text_delta", round: 1, text: "done" },
      ],
      20,
    );
    await ui.send();
    const first = ui.row("Thought for");
    expect(ui.rows()[first + 1]).toContain("ctrl+o");
    const collapsed = ui.frame();
    await ui.click(first + 1);
    expect(ui.frame()).toBe(collapsed);
    await ui.click(first);
    expect(ui.frame()).toContain("secret");
    const expanded = ui.frame();
    await ui.click(ui.row("secret"));
    expect(ui.frame()).toBe(expanded);
  });
  test("wrapped skill user and hint continuations are inert", async () => {
    const ui = await mount([], 40);
    await ui.send("/kit:demo alpha bravo charlie delta echo foxtrot");
    const user = ui.row("> /kit:demo");
    const hint = ui.row("⎿  skill");
    expect(hint).toBeGreaterThan(user + 1);
    expect(ui.rows()[hint + 1]).toContain("show");
    const before = ui.frame();
    await ui.click(user + 1);
    expect(ui.frame()).toBe(before);
    await ui.click(hint + 1);
    expect(ui.frame()).toBe(before);
    await ui.click(hint);
    expect(ui.frame()).toContain(skill.body);
    await ui.click(user);
    expect(ui.frame()).not.toContain(skill.body);
  });
  test("AC-21/22 wrapped tool continuation is inert but first row opens", async () => {
    const ui = await mount(toolEvents, 40);
    await ui.send();
    const first = ui.row("Bash(");
    expect(ui.rows()[first + 1]).toContain("arguments");
    expect(ui.frame()).not.toContain("private tool output");
    const before = ui.frame();
    await ui.click(first + 1);
    expect(ui.frame()).toBe(before);
    await ui.click(first);
    expect(ui.frame()).toContain("private tool output");
  });
});
