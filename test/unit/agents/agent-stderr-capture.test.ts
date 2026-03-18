// RE-ARCH: keep
/**
 * Tests for stderr capture in agent result type
 *
 * Covers: AgentResult interface includes stderr field
 */

import { describe, expect, it } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function createAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: "",
    stderr: "",
    rateLimited: false,
    durationMs: 1000,
    estimatedCost: 0.01,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests for AgentResult interface
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentResult stderr field", () => {
  it("supports stderr field in AgentResult", () => {
    const result = createAgentResult({
      exitCode: 1,
      stderr: "Error: 401 Unauthorized",
    });

    expect(result.stderr).toBe("Error: 401 Unauthorized");
  });

  it("supports empty stderr string", () => {
    const result = createAgentResult({
      stderr: "",
    });

    expect(result.stderr).toBe("");
  });

  it("supports undefined stderr for backward compatibility", () => {
    const result: AgentResult = {
      success: false,
      exitCode: 1,
      output: "output",
      // stderr not provided
      rateLimited: false,
      durationMs: 1000,
      estimatedCost: 0.01,
    };

    expect(result.stderr).toBeUndefined();
  });

  it("can store long error messages in stderr", () => {
    const longStderr = "Error: ".padEnd(1000, "x");
    const result = createAgentResult({
      stderr: longStderr,
    });

    expect(result.stderr).toHaveLength(1000);
    expect(result.stderr).toContain("Error:");
  });

  it("includes stderr in all failure scenarios", () => {
    const scenarios = [
      { exitCode: 1, stderr: "Generic error" },
      { exitCode: 401, stderr: "Unauthorized" },
      { exitCode: 500, stderr: "Internal server error" },
      { exitCode: 124, stderr: "Timeout" },
    ];

    for (const scenario of scenarios) {
      const result = createAgentResult({
        exitCode: scenario.exitCode,
        stderr: scenario.stderr,
      });

      expect(result.exitCode).toBe(scenario.exitCode);
      expect(result.stderr).toBe(scenario.stderr);
    }
  });

  it("preserves newlines in stderr", () => {
    const multilineStderr = "Error: Something failed\nDetails: xyz\nContext: abc";
    const result = createAgentResult({
      stderr: multilineStderr,
    });

    expect(result.stderr).toContain("\n");
    expect(result.stderr).toContain("Details:");
  });

  it("allows stderr with special characters", () => {
    const specialStderr = 'Error: "quoted" with \\backslash and \t tab';
    const result = createAgentResult({
      stderr: specialStderr,
    });

    expect(result.stderr).toBe(specialStderr);
  });

  it("can be serialized to JSON", () => {
    const result = createAgentResult({
      exitCode: 401,
      stderr: "401 Unauthorized: Invalid API key",
    });

    const json = JSON.stringify(result);
    expect(json).toContain("401");
    expect(json).toContain("Unauthorized");

    const parsed = JSON.parse(json) as AgentResult;
    expect(parsed.stderr).toBe("401 Unauthorized: Invalid API key");
  });

  it("maintains other fields when stderr is set", () => {
    const result = createAgentResult({
      success: false,
      exitCode: 1,
      output: "stdout output",
      stderr: "stderr output",
      rateLimited: false,
      durationMs: 5000,
      estimatedCost: 0.05,
      pid: 12345,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("stdout output");
    expect(result.stderr).toBe("stderr output");
    expect(result.rateLimited).toBe(false);
    expect(result.durationMs).toBe(5000);
    expect(result.estimatedCost).toBe(0.05);
    expect(result.pid).toBe(12345);
  });
});
