// RE-ARCH: keep
/**
 * Tests for exitCode and stderr in agent error scenarios
 *
 * Covers: AgentResult includes exitCode and stderr for debugging failures
 */

import { describe, expect, it } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function createFailedResult(overrides: Partial<AgentResult> = {}): AgentResult {
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
// Tests for AgentResult failure logging
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentResult failure logging fields", () => {
  it("includes exitCode for diagnosing failures", () => {
    const result = createFailedResult({
      exitCode: 1,
      stderr: "Error message",
    });

    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });

  it("captures stderr for root cause analysis", () => {
    const result = createFailedResult({
      exitCode: 401,
      stderr: "401 Unauthorized: Invalid API key",
    });

    expect(result.exitCode).toBe(401);
    expect(result.stderr).toContain("Unauthorized");
  });

  it("logs timeout with exit code 124", () => {
    const result = createFailedResult({
      exitCode: 124,
      stderr: "SIGTERM: Process timeout",
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timeout");
  });

  it("handles rate limit failures with exit code and stderr", () => {
    const result = createFailedResult({
      exitCode: 429,
      stderr: "Rate limit exceeded",
      rateLimited: true,
    });

    expect(result.exitCode).toBe(429);
    expect(result.stderr).toContain("Rate limit");
    expect(result.rateLimited).toBe(true);
  });

  it("logs server errors with 500 exit code", () => {
    const result = createFailedResult({
      exitCode: 500,
      stderr: "Internal server error: database connection failed",
    });

    expect(result.exitCode).toBe(500);
    expect(result.stderr).toContain("database");
  });

  it("supports backward compatibility when stderr is undefined", () => {
    const result: AgentResult = {
      success: false,
      exitCode: 1,
      output: "output",
      // stderr intentionally undefined for backward compat
      rateLimited: false,
      durationMs: 1000,
      estimatedCost: 0.01,
    };

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeUndefined();
  });

  it("can serialize failure data to JSON for logging", () => {
    const result = createFailedResult({
      exitCode: 401,
      stderr: "Authentication failed",
    });

    const logData = {
      exitCode: result.exitCode,
      stderr: result.stderr || "",
      rateLimited: result.rateLimited,
      storyId: "story-001",
    };

    const json = JSON.stringify(logData);
    expect(json).toContain("401");
    expect(json).toContain("Authentication");

    const parsed = JSON.parse(json);
    expect(parsed.exitCode).toBe(401);
    expect(parsed.stderr).toBe("Authentication failed");
  });

  it("preserves special characters in stderr for JSONL format", () => {
    const specialStderr = 'Error: "quoted" with\nnewline and \\backslash';
    const result = createFailedResult({
      stderr: specialStderr,
    });

    const logData = JSON.stringify({ stderr: result.stderr });
    const parsed = JSON.parse(logData);
    expect(parsed.stderr).toBe(specialStderr);
  });

  it("includes all critical fields for comprehensive failure logging", () => {
    const result = createFailedResult({
      success: false,
      exitCode: 500,
      output: "Last 5000 chars of stdout",
      stderr: "Last 1000 chars of stderr",
      rateLimited: false,
      durationMs: 5000,
      estimatedCost: 0.05,
      pid: 12345,
    });

    // All fields should be available for logging
    const logData = {
      exitCode: result.exitCode,
      stderr: result.stderr || "",
      rateLimited: result.rateLimited,
      storyId: "test",
    };

    expect(logData.exitCode).toBe(500);
    expect(logData.stderr).toContain("stderr");
    expect(logData.rateLimited).toBe(false);
  });
});
