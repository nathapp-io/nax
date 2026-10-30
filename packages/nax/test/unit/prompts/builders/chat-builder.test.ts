import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import { chatPermissionParagraph } from "@/prompts/builders/chat-builder";

const rule = {
  ruleId: "error-handling",
  displayPath: ".nax/rules/error-handling.md",
  source: "repo" as const,
  description: "Error handling conventions",
  appliesTo: ["src/**"],
  priority: 1,
};

function guarded(): string {
  return prompts.buildChatInstructions({ mode: "guarded", rulesIndex: [] });
}

describe("chatPermissionParagraph", () => {
  test("shadow AC-8 returns the exact guarded sentence", () => {
    expect(chatPermissionParagraph("guarded")).toBe(
      "In guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.",
    );
  });
});

describe("buildChatInstructions", () => {
  test("shadow AC-9 places the exact sentence in the permission section", () => {
    expect(guarded().split("## Permission mode\n\n")[1]?.split("\n\n")[0]).toBe(
      "In guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.",
    );
  });
  test("AC-1: is exported from src/prompts", () => {
    expect(typeof prompts.buildChatInstructions).toBe("function");
  });
  test.each([
    ["AC-2", "## Permission mode"],
    [
      "AC-3",
      "In guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.",
    ],
    ["AC-5", "## Commands outside the sandbox"],
  ])("%s: includes %s", (_ac, text) => {
    expect(guarded()).toContain(text);
  });
  test("AC-4: full mode runs tools without asking", () => {
    const text = prompts.buildChatInstructions({ mode: "full", rulesIndex: [] });
    expect(text).toContain("tools run without asking");
    expect(text).not.toContain("put to the person before they run");
  });
  test("AC-6: names escalation arguments and limits use to blocked resources", () => {
    const section = guarded().split("## Commands outside the sandbox\n")[1]?.split("\n## ")[0] ?? "";
    for (const text of [
      "unsandboxed: true",
      "unsandboxedReason",
      "only when",
      "network",
      "Docker socket",
      "local port",
      "device",
      "sandbox blocks",
    ]) {
      expect(section).toContain(text);
    }
  });
  test("AC-7: includes the supplied rules index entry", () => {
    const text = prompts.buildChatInstructions({ mode: "guarded", rulesIndex: [rule] });
    expect(text).toContain("## Rules index");
    expect(text).toContain("- `error-handling` (.nax/rules/error-handling.md)");
  });
  test("AC-8: uses automatic first-touch rule delivery wording", () => {
    const text = prompts.buildChatInstructions({ mode: "guarded", rulesIndex: [rule] });
    expect(text).toContain(
      "Each rule's full text is shown to you the first time you read, write or edit a file it applies to.",
    );
    expect(text).toContain(prompts.buildRulesIndexSection({ entries: [rule], shownAutomatically: true }));
  });
  test("AC-9: omits the rules section for an empty index", () => {
    expect(guarded()).not.toContain("## Rules index");
  });
  test("AC-16: native guarded and full instructions keep their exact text", () => {
    const commands =
      "## Commands outside the sandbox\n\nSet `unsandboxed: true` with an `unsandboxedReason` only when a command needs the network, the Docker socket, a local port or a device the sandbox blocks.";
    const intro = "You are an interactive coding agent working in this repository with the person.";
    const rules = prompts.buildRulesIndexSection({ entries: [rule], shownAutomatically: true });
    const withRules = (mode: "guarded" | "full") => prompts.buildChatInstructions({ mode, rulesIndex: [rule] });
    expect(guarded()).toBe(`${intro}\n\n## Permission mode\n\n${chatPermissionParagraph("guarded")}\n\n${commands}`);
    expect(prompts.buildChatInstructions({ mode: "full", rulesIndex: [] })).toBe(
      `${intro}\n\n## Permission mode\n\nIn full mode, tools run without asking.\n\n${commands}`,
    );
    expect(withRules("guarded")).toBe(`${guarded()}\n\n${rules}`);
    expect(withRules("full")).toEndWith(`\n\n${rules}`);
  });
  test("introduces an interactive repository coding partner", () => {
    expect(guarded().split("\n\n")[0]).toBe(
      "You are an interactive coding agent working in this repository with the person.",
    );
  });
});

describe("buildChatFeatureMessage", () => {
  test("AC-10: starts with the feature heading", () => {
    expect(prompts.buildChatFeatureMessage({ feature: "auth", spec: "S", prd: "{}", message: "go" })).toStartWith(
      "## Feature auth",
    );
  });
  test("AC-11: fences spec and PRD in order before the final personal message", () => {
    expect(prompts.buildChatFeatureMessage({ feature: "auth", spec: "S", prd: "{}", message: "go" })).toBe(
      "## Feature auth\n\n```markdown\nS\n```\n\n```json\n{}\n```\n\ngo",
    );
  });
  test("AC-12: uses exactly one fenced block without PRD", () => {
    const text = prompts.buildChatFeatureMessage({ feature: "auth", spec: "S", message: "go" });
    expect(text.match(/^```/gm)).toHaveLength(2);
    expect(text).toBe("## Feature auth\n\n```markdown\nS\n```\n\ngo");
  });
  test("accepts an empty message and a supplied empty PRD", () => {
    expect(prompts.buildChatFeatureMessage({ feature: "auth", spec: "", prd: "", message: "" })).toBe(
      "## Feature auth\n\n```markdown\n\n```\n\n```json\n\n```\n\n",
    );
  });
  test("keeps nested Markdown fences inside the spec block", () => {
    const spec = "Example:\n```ts\nconst x = 1;\n```";
    expect(prompts.buildChatFeatureMessage({ feature: "auth", spec, message: "go" })).toBe(
      `## Feature auth\n\n\`\`\`\`markdown\n${spec}\n\`\`\`\`\n\ngo`,
    );
  });
});
