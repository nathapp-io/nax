import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, createChatAskController } from "@/chat";
import { buildChatFeatureMessage, buildCommandMessage, buildSkillInvocationMessage } from "@/prompts";
import { buildResourceCatalog, type ResourcePackage, type SkillResource } from "@/resources";
import { ChatApp } from "@/tui/chat";
import { _slashCommandDeps, parseSlashCommand, runSlashCommand } from "@/tui/chat/slash-commands";

const originalRead = _slashCommandDeps.readText;
afterEach(() => {
  cleanup();
  _slashCommandDeps.readText = originalRead;
});
const skill: SkillResource = {
  kind: "skill",
  name: "brainstorming",
  qualifiedName: "superpowers:brainstorming",
  description: "Explore ideas",
  body: "Brainstorm thoroughly",
  baseDir: "/kit/brainstorming",
  path: "/kit/brainstorming/SKILL.md",
  modelInvocable: true,
  origin: { kind: "nax-plugin", plugin: "superpowers" },
};
function fixture() {
  const pkg: ResourcePackage = {
    id: "nax:superpowers",
    origin: skill.origin,
    root: "/kit",
    agents: [],
    mcpServers: [],
    hooks: [],
    diagnostics: [],
    skills: [
      skill,
      { ...skill, name: "manual", qualifiedName: "superpowers:manual", modelInvocable: false },
      { ...skill, name: "deploy", qualifiedName: "superpowers:deploy" },
      { ...skill, name: "mode", qualifiedName: "superpowers:mode" },
    ],
    commands: ["review", "deploy"].map((name) => ({
      kind: "command",
      name,
      qualifiedName: `superpowers:${name}`,
      description: `Run ${name}`,
      template: `${name === "review" ? "Review" : "Deploy"} $ARGUMENTS`,
      path: `/kit/${name}.md`,
      origin: skill.origin,
    })),
  };
  const send = mock(async (_message: string, _listener: Parameters<ChatHost["send"]>[1]) => {});
  const host: ChatHost = {
    repoRoot: "/repo",
    catalog: buildResourceCatalog([pkg]),
    models: ["model"],
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
    send,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: mock(async (_input: { mode?: "full" | "guarded"; model?: string }) => {}),
    cancel: () => {},
    close: async () => {},
    listSessions: async () => [],
  };
  return { host, send };
}
function mount() {
  const fixtureHost = fixture();
  const ui = render(<ChatApp host={fixtureHost.host} />);
  const line = async (text: string) => {
    act(() => {
      ui.stdin.write(text);
    });
    await Promise.resolve(
      act(async () => {
        ui.stdin.write("\r");
      }),
    );
  };
  return { ...ui, ...fixtureHost, line };
}
function command(text: string) {
  const parsed = parseSlashCommand(text);
  if (!parsed) throw new Error("fixture must be a slash command");
  return parsed;
}
describe("catalog slash routing", () => {
  test.each([
    ["AC-1", "/brainstorming idea", "idea"],
    ["AC-2", "/superpowers:brainstorming", ""],
    ["AC-3", "/manual", ""],
  ])("%s sends explicitly invoked skill builder text", async (_ac, input, args) => {
    const ui = mount();
    await ui.line(input);
    const selected = ui.host.catalog?.findSkill(command(input).name);
    expect(selected).toBeDefined();
    if (!selected) throw new Error("fixture skill missing");
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith(
      buildSkillInvocationMessage({ skill: selected, args: args ? ` ${args}` : "" }),
      expect.any(Function),
    );
    expect(ui.send.mock.calls[0]?.[0]).toContain(skill.body);
    if (args) expect(ui.send.mock.calls[0]?.[0]).toContain(args);
    if (_ac === "AC-2") expect(ui.send.mock.calls[0]?.[0]).toContain('<skill name="superpowers:brainstorming"');
  });
  test.each([
    ["AC-4", "/review x.ts", "Review x.ts"],
    ["AC-6", "/deploy", "Deploy "],
  ])("%s sends the command builder text before considering skills", async (_ac, input, expected) => {
    const ui = mount();
    await ui.line(input);
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith(expected, expect.any(Function));
  });
  test("command outcome retains template and raw rest for later expansion", async () => {
    const { host } = fixture();
    expect(await runSlashCommand(command("/review  x.ts"), { host, show: () => {} })).toEqual({
      kind: "command",
      name: "review",
      template: "Review $ARGUMENTS",
      rest: "  x.ts",
    });
    expect(buildCommandMessage("Review $ARGUMENTS", "  x.ts")).toBe("Review x.ts");
  });
  test("AC-5 feature returns a send outcome containing builder text", async () => {
    const { host } = fixture();
    _slashCommandDeps.readText = async (path) => (path.endsWith("spec.md") ? "fixture spec" : undefined);
    expect(await runSlashCommand(command("/feature auth go"), { host, show: () => {} })).toEqual({
      kind: "send",
      message: buildChatFeatureMessage({ feature: "auth", spec: "fixture spec", message: "go" }),
    });
  });
  test("AC-7 AC-8 built-in mode wins and never sends", async () => {
    const ui = mount();
    await ui.line("/mode full");
    expect(ui.host.switchTo).toHaveBeenCalledWith({ mode: "full" });
    expect(ui.send).not.toHaveBeenCalled();
  });
  test("AC-9 AC-10 missing entry reports unknown command without sending", async () => {
    const ui = mount();
    await ui.line("/nothing");
    expect(ui.lastFrame()).toContain("unknown command /nothing");
    expect(ui.send).not.toHaveBeenCalled();
  });
  test("AC-11 help appends commands then skills after built-ins", async () => {
    const ui = mount();
    await ui.line("/help");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("/brainstorming - Explore ideas");
    expect(frame).toContain("/review - Run review");
    expect(frame.indexOf("/review -")).toBeGreaterThan(frame.indexOf("/quit"));
    expect(frame.indexOf("/brainstorming -")).toBeGreaterThan(frame.indexOf("/review -"));
  });
  test("AC-12 local command returns undefined", async () => {
    const { host } = fixture();
    expect(await runSlashCommand(command("/mode full"), { host, show: () => {} })).toBeUndefined();
    expect(host.switchTo).toHaveBeenCalledWith({ mode: "full" });
  });
});
