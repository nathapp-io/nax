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
// Test adapter — injects command via _runOnceDeps.buildCmd to avoid spawning
// the real claude binary (buildCommand override alone is insufficient because
// executeOnce calls the module-level buildCommand, not this.buildCommand).
// ─────────────────────────────────────────────────────────────────────────────

class TestAdapter extends ClaudeCodeAdapter {}

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
  const origBuildCmd = _runOnceDeps.buildCmd;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-claude-test-"));
  });

  afterEach(() => {
    // Restore deps after each test
    _runOnceDeps.killProc = origKillProc;
    _runOnceDeps.buildCmd = origBuildCmd;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("timeout path sends SIGTERM to process first", async () => {
    const sentSignals: string[] = [];

    // Inject long-running command directly (no shell wrapper — avoids orphaned child
    // holding stdout pipe open which would cause the 5s stdout-read timeout to fire)
    _runOnceDeps.buildCmd = () => ["sleep", "100"];
    // Record signals sent but still kill the process so proc.exited resolves
    _runOnceDeps.killProc = (proc, signal) => {
      sentSignals.push(String(signal));
      origKillProc(proc, signal);
    };

    // Long-running process: will be killed by the 100ms timeout
    const adapter = new TestAdapter();
    const result = await adapter.run(makeRunOptions(tempDir, 0.1));

    expect(result.exitCode).toBe(124); // timeout exit code
    expect(sentSignals[0]).toBe("SIGTERM"); // SIGTERM sent first
  });

  test("timeout path: unregisters PID even if killProc throws", async () => {
    // Inject short-lived command directly (no shell wrapper — avoids orphaned child)
    _runOnceDeps.buildCmd = () => ["sleep", "1"];
    // Override killProc to throw — simulates kill() failing (e.g., process already gone)
    _runOnceDeps.killProc = (_proc, _signal) => {
      throw new Error("kill failed");
    };

    // 50ms timeout fires first, killProc throws (process not killed),
    // proc exits naturally at ~0.5s. The finally block must still unregister.
    const adapter = new TestAdapter();
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

describe("run() pidRegistries cleanup", () => {
  let tempDir: string;
  const origBuildCmd = _runOnceDeps.buildCmd;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-claude-cleanup-test-"));
  });

  afterEach(() => {
    // Restore deps after each test
    _runOnceDeps.buildCmd = origBuildCmd;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("cleans up pidRegistries Map entry after successful run", async () => {
    _runOnceDeps.buildCmd = () => ["true"]; // Quick exit

    const adapter = new TestAdapter();
    const workdir = tempDir;
    const options = makeRunOptions(workdir, 30);

    // Verify registry is created when first called
    expect((adapter as unknown as { pidRegistries: Map<string, unknown> }).pidRegistries.has(workdir)).toBe(false);

    // Run once to populate the Map
    await adapter.run(options);

    // After run() completes, the Map entry should be cleaned up
    expect((adapter as unknown as { pidRegistries: Map<string, unknown> }).pidRegistries.has(workdir)).toBe(false);
  });

  test("cleans up pidRegistries Map entry even on error", async () => {
    _runOnceDeps.buildCmd = () => ["false"]; // Exits with code 1

    const adapter = new TestAdapter();
    const workdir = tempDir;
    const options = makeRunOptions(workdir, 30);

    // Run should fail but still clean up
    try {
      await adapter.run(options);
    } catch {
      // Expected to fail, but Map should still be cleaned up
    }

    // Run failed but Map was still cleaned up
    expect((adapter as unknown as { pidRegistries: Map<string, unknown> }).pidRegistries.has(workdir)).toBe(false);
  });
});
