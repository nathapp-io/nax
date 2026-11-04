import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import { chatPermissionParagraph } from "@/prompts/builders/chat-builder";
import { cleanIndexDescription } from "@/prompts/builders/skills-builder";
import type { AgentResource } from "@/resources/types";

const agent: AgentResource = {
  kind: "agent",
  name: "reviewer",
  qualifiedName: "reviewer",
  description: "Reviews diffs",
  prompt: "Review the diff carefully.",
  path: "/agents/reviewer.md",
  origin: { kind: "claude-project" },
};

const ruleEntry = {
  ruleId: "error-handling",
  displayPath: ".nax/rules/error-handling.md",
  source: "repo" as const,
  description: "Error handling conventions",
  appliesTo: ["src/**"],
  priority: 1,
};

function lines(text: string): string[] {
  return text.split("\n");
}

describe("cleanIndexDescription", () => {
  test("collapses whitespace runs and removes control characters", () => {
    expect(cleanIndexDescription("a\n\n  b\u0007c")).toBe("a bc");
  });

  test("truncates a 300-character line to its first 200 characters", () => {
    const text = "abcdefghij".repeat(30);
    expect(text).toHaveLength(300);
    expect(cleanIndexDescription(text)).toBe(text.slice(0, 200));
  });
});

describe("buildSkillsInstructions after the helper extraction", () => {
  test("returns the frozen text for a messy description", () => {
    expect(prompts.buildSkillsInstructions([{ qualifiedName: "fixture", description: "a\n\n  b\u0007c" }])).toBe(
      "When a skill matches a task, call nax-skills__load with the skill name before acting on the task. Load the skill's references files with nax-skills__load and file.\n- fixture: a bc",
    );
  });
});

describe("buildChatInstructions after the permission extraction", () => {
  test("guarded mode returns the frozen text", () => {
    expect(prompts.buildChatInstructions({ mode: "guarded", rulesIndex: [] })).toBe(
      "You are an interactive coding agent working in this repository with the person.\n\n## Permission mode\n\nIn guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.\n\n## Commands outside the sandbox\n\nSet `unsandboxed: true` with an `unsandboxedReason` only when a command needs the network, the Docker socket, a local port or a device the sandbox blocks.",
    );
  });

  test("full mode returns the frozen text", () => {
    expect(prompts.buildChatInstructions({ mode: "full", rulesIndex: [] })).toBe(
      "You are an interactive coding agent working in this repository with the person.\n\n## Permission mode\n\nIn full mode, tools run without asking.\n\n## Commands outside the sandbox\n\nSet `unsandboxed: true` with an `unsandboxedReason` only when a command needs the network, the Docker socket, a local port or a device the sandbox blocks.",
    );
  });
});

describe("buildAgentsInstructions", () => {
  test("first line names nax-agents__run", () => {
    const first = lines(prompts.buildAgentsInstructions([agent]))[0];
    expect(first).toContain("nax-agents__run");
  });

  test("lists each agent as a '- name: description' line", () => {
    expect(lines(prompts.buildAgentsInstructions([agent]))).toContain("- reviewer: Reviews diffs");
  });

  test("cleans a multi-line description like the skills index", () => {
    const text = prompts.buildAgentsInstructions([{ ...agent, description: "Line one\nLine two" }]);
    expect(lines(text)).toContain("- reviewer: Line one Line two");
  });

  test("lists 150 agents out of 151 and ends with the overflow line", () => {
    const many = Array.from({ length: 151 }, (_, i) => ({ ...agent, qualifiedName: `a${i}`, description: `d${i}` }));
    const out = lines(prompts.buildAgentsInstructions(many));
    expect(out.filter((l) => /^- a\d+: /.test(l))).toHaveLength(150);
    expect(out[out.length - 1]).toBe("- ... and 1 more");
  });

  test("removes control characters from an advertised description", () => {
    const text = prompts.buildAgentsInstructions([{ ...agent, description: "a\u0007b" }]);
    expect(text).not.toContain("\u0007");
    expect(lines(text)).toContain("- reviewer: ab");
  });
});

describe("buildSubagentInstructions", () => {
  test("ends with the agent's prompt", () => {
    const text = prompts.buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [] });
    expect(text.endsWith(agent.prompt)).toBe(true);
  });

  test("contains the guarded permission paragraph", () => {
    const text = prompts.buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [] });
    expect(text).toContain(chatPermissionParagraph("guarded"));
    expect(text).toContain("In guarded mode, commands run inside the sandbox");
  });

  test("contains the full permission paragraph", () => {
    const text = prompts.buildSubagentInstructions({ agent, mode: "full", rulesIndex: [] });
    expect(text).toContain(chatPermissionParagraph("full"));
    expect(text).toContain("In full mode, tools run without asking.");
  });

  test("contains the rules index line of an entry and still ends with the prompt", () => {
    const text = prompts.buildSubagentInstructions({ agent, mode: "full", rulesIndex: [ruleEntry] });
    expect(text).toContain(
      "- `error-handling` (.nax/rules/error-handling.md): Error handling conventions. Applies to: src/**",
    );
    expect(text.endsWith(agent.prompt)).toBe(true);
  });
});

describe("buildSubagentInstructions memory section", () => {
  const memoryIndex = "# Memory\n- [project] a — b";

  test("AC-10: places the memory section before the agent's prompt", () => {
    const text = prompts.buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [], memoryIndex });
    const section = prompts.buildMemorySection(memoryIndex);
    expect(text).toContain(section);
    expect(text.indexOf(section)).toBeLessThan(text.indexOf(agent.prompt));
  });

  test("AC-11: the same input without a memory index matches the pre-feature text", () => {
    expect(prompts.buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [] })).toBe(
      [chatPermissionParagraph("guarded"), agent.prompt].join("\n\n"),
    );
  });
});

describe("buildSubagentInstructions native text", () => {
  test("AC-12: stays the permission paragraph then the agent prompt", () => {
    expect(
      prompts.buildSubagentInstructions({ agent: { prompt: "Review it." }, mode: "guarded", rulesIndex: [] }),
    ).toBe([chatPermissionParagraph("guarded"), "Review it."].join("\n\n"));
  });
});

describe("buildAcpSubagentInstructions", () => {
  const acpAgent = { qualifiedName: "spec-reviewer", prompt: "Review it." };

  test("AC-1: opens with the subagent line and ends with the agent's prompt", () => {
    const text = prompts.buildAcpSubagentInstructions({ agentLabel: "Codex", agent: acpAgent });
    const sections = text.split("\n\n");
    expect(sections[0]).toBe(
      "You are Codex, running as the nax chat subagent spec-reviewer. Use your own tools for the work. Answer with your final result as text; the chat that called you reads only that.",
    );
    expect(sections[sections.length - 1]).toBe("Review it.");
  });

  test("AC-2: orders tool instructions, then the memory section, then the agent's prompt", () => {
    const memoryIndex = "# Memory\n- [project] a — b";
    const text = prompts.buildAcpSubagentInstructions({
      agentLabel: "Codex",
      agent: acpAgent,
      toolInstructions: "TOOLS",
      memoryIndex,
    });
    const toolsAt = text.indexOf("TOOLS");
    const memoryAt = text.indexOf(prompts.buildMemorySection(memoryIndex));
    const promptAt = text.indexOf(acpAgent.prompt);
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    expect(memoryAt).toBeGreaterThan(toolsAt);
    expect(promptAt).toBeGreaterThan(memoryAt);
    expect(text).toEndWith(acpAgent.prompt);
  });

  test("leaves out an empty tool text and an absent memory index", () => {
    const text = prompts.buildAcpSubagentInstructions({
      agentLabel: "Cursor",
      agent: acpAgent,
      toolInstructions: "",
    });
    expect(text).toBe(
      "You are Cursor, running as the nax chat subagent spec-reviewer. Use your own tools for the work. Answer with your final result as text; the chat that called you reads only that.\n\nReview it.",
    );
  });
});

describe("prompts barrel", () => {
  test("exposes both builders as functions", () => {
    expect(typeof prompts.buildAgentsInstructions).toBe("function");
    expect(typeof prompts.buildSubagentInstructions).toBe("function");
  });

  test("exposes buildAcpSubagentInstructions", () => {
    expect(typeof prompts.buildAcpSubagentInstructions).toBe("function");
  });
});
