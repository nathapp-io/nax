import { describe, expect, test } from "bun:test";
import type { AgentsRunResult } from "@/cli/agents-run-exec";
import { agentsRunOutput } from "@/cli/agents-run-output";

function result(overrides: Partial<AgentsRunResult> = {}): AgentsRunResult {
  return {
    agent: "superpowers:code-reviewer",
    model: "acp:codex/gpt-6.1-terra",
    status: "completed",
    output: "VERDICT: ready",
    deniedAsks: [],
    ...overrides,
  };
}

describe("agentsRunOutput", () => {
  test("AC-1: sends completed plain output to stdout and exits successfully", () => {
    expect(agentsRunOutput(result(), false)).toEqual({ stdout: "VERDICT: ready\n", exitCode: 0 });
  });

  test.each([
    ["failed", "boom"],
    ["cancelled", "c"],
    ["timeout", "t"],
  ] as const)("AC-2/3/4: sends %s plain output to stderr and exits unsuccessfully", (status, output) => {
    expect(agentsRunOutput(result({ status, output }), false)).toEqual({ stderr: `${output}\n`, exitCode: 1 });
  });

  test("AC-5: writes denied asks to stderr in arrival order", () => {
    const value = agentsRunOutput(
      result({
        deniedAsks: [
          { kind: "approval", tool: "Bash", summary: "rm x" },
          { kind: "question", text: "Which?" },
        ],
      }),
      false,
    );
    expect(value.stderr).toBe("[agents run] denied Bash: rm x\n[agents run] unanswered question: Which?\n");
  });

  test("AC-6: puts failed result text before denied asks in stderr", () => {
    const value = agentsRunOutput(
      result({
        status: "failed",
        output: "boom",
        deniedAsks: [{ kind: "approval", tool: "Bash", summary: "rm x" }],
      }),
      false,
    );
    expect(value).toEqual({ stderr: "boom\n[agents run] denied Bash: rm x\n", exitCode: 1 });
  });

  test("AC-7: serializes a completed result as one JSON line", () => {
    const expected = result();
    const value = agentsRunOutput(expected, true);
    expect(value.exitCode).toBe(0);
    expect(value.stderr).toBeUndefined();
    expect(value.stdout?.endsWith("\n")).toBe(true);
    expect(JSON.parse(value.stdout ?? "")).toEqual(expected);
  });

  test("AC-8: serializes a failed result with exit code one and no stderr", () => {
    const value = agentsRunOutput(result({ status: "failed", output: "boom" }), true);
    expect(value.exitCode).toBe(1);
    expect(value.stderr).toBeUndefined();
    expect(JSON.parse(value.stdout ?? "").status).toBe("failed");
  });

  test("AC-9: omits costUsd when it is absent", () => {
    const value = agentsRunOutput(result(), true);
    expect(Object.keys(JSON.parse(value.stdout ?? ""))).not.toContain("costUsd");
  });

  test("AC-10: escapes embedded newlines and quotes into exactly one JSON line", () => {
    const output = 'first line\nand a "quote"';
    const value = agentsRunOutput(result({ output }), true);
    expect(value.stdout?.match(/\n/g)).toHaveLength(1);
    expect(value.stdout?.endsWith("\n")).toBe(true);
    expect(JSON.parse(value.stdout ?? "").output).toBe(output);
  });
});
