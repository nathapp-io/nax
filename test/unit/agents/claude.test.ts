// RE-ARCH: keep
/**
 * Tests for ClaudeCodeAdapter.runOnce() timeout behavior
 *
 * Covers: US-001 - runOnce() SIGKILL follow-up after grace period
 * - SIGTERM is sent first on timeout
 * - PID is always unregistered in finally block, even if kill() throws
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, _runOnceDeps } from "../../../src/agents/claude";
import type { AgentRunOptions } from "../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test adapter — overrides buildCommand to avoid requiring the claude binary
// ─────────────────────────────────────────────────────────────────────────────

class TestAdapter extends ClaudeCodeAdapter {
  private readonly testCmd: string[];

  constructor(cmd: string[]) {
    super();
    this.testCmd = cmd;
  }

  override buildCommand(_options: AgentRunOptions): string[] {
    return this.testCmd;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRunOptions(workdir: string, timeoutSeconds: number): AgentRunOptions {
  return {
    workdir,
    prompt: "test",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runOnce() timeout behavior", () => {
  let tempDir: string;
  const origKillProc = _runOnceDeps.killProc;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-claude-test-"));
  });

  afterEach(() => {
    // Restore original killProc after each test
    _runOnceDeps.killProc = origKillProc;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("timeout path sends SIGTERM to process first", async () => {
    const sentSignals: string[] = [];

    // Record signals sent but still kill the process so proc.exited resolves
    _runOnceDeps.killProc = (proc, signal) => {
      sentSignals.push(String(signal));
      origKillProc(proc, signal);
    };

    // Long-running process: will be killed by the 100ms timeout
    const adapter = new TestAdapter(["/bin/sh", "-c", "sleep 100"]);
    const result = await adapter.run(makeRunOptions(tempDir, 0.1));

    expect(result.exitCode).toBe(124); // timeout exit code
    expect(sentSignals[0]).toBe("SIGTERM"); // SIGTERM sent first
  });

  test("timeout path: unregisters PID even if killProc throws", async () => {
    // Override killProc to throw — simulates kill() failing (e.g., process already gone)
    _runOnceDeps.killProc = (_proc, _signal) => {
      throw new Error("kill failed");
    };

    // Use a short-lived process (0.5s) with a timeout that fires first (50ms).
    // killProc throws (process not killed), so proc exits naturally at ~0.5s.
    // The finally block must still call unregister regardless.
    const adapter = new TestAdapter(["/bin/sh", "-c", "sleep 0.5"]);
    const options = makeRunOptions(tempDir, 0.05); // 50ms timeout

    // Should not throw — kill errors are caught internally
    await adapter.run(options);

    // PID must have been unregistered (file empty or absent)
    const pidsFile = join(tempDir, ".nax-pids");
    if (existsSync(pidsFile)) {
      const content = await Bun.file(pidsFile).text();
      expect(content.trim()).toBe("");
    }
  });
});
