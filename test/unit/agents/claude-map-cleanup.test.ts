/**
 * Tests for FIX-010: PID Registry Map Cleanup
 *
 * Verifies that pidRegistries Map entries are cleaned up after run() completes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, _runOnceDeps } from "../../../src/agents/claude";
import type { AgentRunOptions } from "../../../src/agents/types";

class TestAdapter extends ClaudeCodeAdapter {}

function makeRunOptions(workdir: string): AgentRunOptions {
  return {
    workdir,
    prompt: "test",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
  };
}

describe("FIX-010: pidRegistries Map cleanup", () => {
  let tempDir: string;
  const origBuildCmd = _runOnceDeps.buildCmd;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-fix010-test-"));
  });

  afterEach(() => {
    _runOnceDeps.buildCmd = origBuildCmd;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("cleans up pidRegistries Map entry after successful run", async () => {
    _runOnceDeps.buildCmd = () => ["true"]; // Quick exit

    const adapter = new TestAdapter();
    const adapterAny = adapter as unknown as { pidRegistries: Map<string, unknown> };
    const workdir = tempDir;
    const options = makeRunOptions(workdir);

    // Map should be empty initially
    expect(adapterAny.pidRegistries.has(workdir)).toBe(false);

    // Run once - this creates the registry
    await adapter.run(options);

    // After run(), the Map entry should be deleted (cleanup happened)
    expect(adapterAny.pidRegistries.has(workdir)).toBe(false);
  });

  test("cleans up Map entry even when run fails", async () => {
    _runOnceDeps.buildCmd = () => ["false"]; // Exit code 1

    const adapter = new TestAdapter();
    const adapterAny = adapter as unknown as { pidRegistries: Map<string, unknown> };
    const workdir = tempDir;
    const options = makeRunOptions(workdir);

    try {
      await adapter.run(options);
    } catch {
      // Expected to fail
    }

    // Map should still be cleaned up even though run failed
    expect(adapterAny.pidRegistries.has(workdir)).toBe(false);
  });

  test("prevents unbounded Map growth across multiple runs", async () => {
    _runOnceDeps.buildCmd = () => ["true"];

    const adapter = new TestAdapter();
    const adapterAny = adapter as unknown as { pidRegistries: Map<string, unknown> };

    // Create multiple temp directories and run in each
    const dirs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const dir = mkdtempSync(join(tmpdir(), `nax-cleanup-${i}-`));
      dirs.push(dir);
      await adapter.run(makeRunOptions(dir));
    }

    // Map should be empty (all cleaned up)
    expect(adapterAny.pidRegistries.size).toBe(0);

    // Cleanup temp dirs
    for (const dir of dirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true });
      }
    }
  });
});
