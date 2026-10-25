import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";

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

describe("buildChatInstructions", () => {
  test("AC-1: is exported from src/prompts", () => {
    expect(typeof prompts.buildChatInstructions).toBe("function");
  });
  test.each([
    ["AC-2", "## Permission mode"],
    ["AC-3", "edits, deletes, commits and every shell command are put to the person before they run"],
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
