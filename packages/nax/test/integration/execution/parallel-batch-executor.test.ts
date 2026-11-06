import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Test Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-ac-");
  initLogger();
});

afterEach(() => {
  resetLogger();
  cleanupTempDir(tmpDir);
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: runner-execution always calls executeUnified
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: runner-execution unified dispatch", () => {
  test("runner-execution.ts contains no conditional parallel dispatch branch", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../src/execution/runner-execution.ts")).text();
    expect(source).not.toContain("runParallelExecution");
  });

  test("always calls executeUnified without forwarding parallelCount", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../src/execution/runner-execution.ts")).text();
    expect(source).toContain("executeUnified");
    expect(source).not.toContain("parallelCount");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: parallel-lifecycle.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-27: parallel-lifecycle deleted", () => {
  test("parallel-lifecycle.ts does not exist and has no importers", async () => {
    const filePath = join(import.meta.dir, "../../../src/execution/lifecycle/parallel-lifecycle.ts");
    expect(await Bun.file(filePath).exists()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: runner.ts removes _runnerDeps.runParallelExecution reference
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-28: runner.ts cleanup", () => {
  test("runner.ts does not reference _runnerDeps.runParallelExecution", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../src/execution/runner.ts")).text();
    expect(source).not.toContain("runParallelExecution");
  });
});
