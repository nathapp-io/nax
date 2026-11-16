import { describe, expect, test } from "bun:test";
import { formatJobStrip } from "@/tui/chat/chat-status";

const SHELL = { command: "bun test" };
const OTHER_SHELL = { command: "ls" };
const AGENT = { command: "code-reviewer: Review the spec", kind: "agent" as const };
const OTHER_AGENT = { command: "general: find the bug", kind: "agent" as const };

describe("formatJobStrip agent counts", () => {
  test("AC-20 draws the shell part then the agent part", () => {
    expect(formatJobStrip([], [SHELL, AGENT])).toBe("1 shell · 1 agent");
  });

  test("AC-21 counts only agents as agents, omitting the zero shell part", () => {
    expect(formatJobStrip([], [AGENT, OTHER_AGENT])).toBe("2 agents");
  });

  test("AC-22 two shells stay the shell part alone", () => {
    expect(formatJobStrip([], [SHELL, OTHER_SHELL])).toBe("2 shells");
  });

  test("keeps the job strip ahead of both task parts", () => {
    expect(formatJobStrip([{ kind: "plan", target: "f1" }], [SHELL, AGENT])).toBe("plan f1 · 1 shell · 1 agent");
  });
});
