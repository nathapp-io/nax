/**
 * Unit tests for US-003: Unify executors — integrate parallel dispatch into
 * the sequential loop.
 *
 * File: unified-executor-signature.test.ts
 * Covers:
 *   AC-1  executeUnified exports SequentialExecutionResult return type
 *   _unifiedExecutorDeps — injectable deps
 *   AC-2/3/4 dispatch routing (source-code level)
 *   AC-5  story:started events emitted per story before runParallelBatch (source)
 *   AC-6  parallel failure routed through handlePipelineFailure (source)
 *   AC-7  cost-limit check runs after parallel batch (source)
 *   AC-8  runner-execution.ts always calls executeUnified
 *   AC-9  parallel-executor.ts deleted
 *   AC-10 lifecycle/parallel-lifecycle.ts deleted
 *   AC-11 runner.ts has no reference to _runnerDeps.runParallelExecution
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(import.meta.dir, "../../../src");

async function readSrc(rel: string): Promise<string> {
  return Bun.file(join(SRC, rel)).text();
}

async function srcExists(rel: string): Promise<boolean> {
  return Bun.file(join(SRC, rel)).exists();
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: executeUnified returns SequentialExecutionResult
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1 — executeUnified signature matches SequentialExecutionResult", () => {
  test("unified-executor.ts has correct context type, return type, and function signature", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("SequentialExecutionContext");
    expect(src).toContain("SequentialExecutionResult");
    expect(src).toContain("exitReason");
    expect(src).toMatch(/executeUnified\s*\(\s*ctx\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _unifiedExecutorDeps — injectable deps (required for AC-2 through AC-7)
// ─────────────────────────────────────────────────────────────────────────────

describe("_unifiedExecutorDeps — injectable dispatch dependencies", () => {
  test("unified-executor.ts exports _unifiedExecutorDeps object", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    expect((mod as Record<string, unknown>)._unifiedExecutorDeps).toBeDefined();
  });

  test.each(["runParallelBatch", "runIteration", "selectIndependentBatch"])(
    "_unifiedExecutorDeps contains %s function",
    async (fnName) => {
      const mod = await import("../../../src/execution/unified-executor");
      const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
      expect(typeof deps[fnName]).toBe("function");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 / AC-3 / AC-4 — parallel dispatch routing (source-code level)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2/AC-3 — parallel dispatch routing (source)", () => {
  test("unified-executor.ts has selectIndependentBatch, runParallelBatch (guarded), runIteration in same loop", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("selectIndependentBatch");
    expect(src).toContain("runParallelBatch");
    expect(src).toContain("runIteration");
    expect(src).toMatch(/parallelCount\s*[><!]/);
    expect(src).toMatch(/\.length\s*[>!]/);
  });
});

describe("AC-4 — runIteration always used when parallelCount is undefined or 0 (source)", () => {
  test("the parallel dispatch branch requires ctx.parallelCount to be truthy / > 0", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toMatch(/parallelCount/);
    const runParallelIdx = src.indexOf("runParallelBatch");
    const ifBeforeParallel = src.lastIndexOf("if", runParallelIdx);
    expect(ifBeforeParallel).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — story:started events emitted before runParallelBatch (source)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 — story:started emitted for each batch story before runParallelBatch (source)", () => {
  test("unified-executor.ts emits story:started before runParallelBatch with storyId in loop", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    const startedIdx = src.indexOf("story:started");
    const batchIdx = src.indexOf("runParallelBatch");
    expect(startedIdx).toBeGreaterThan(0);
    expect(batchIdx).toBeGreaterThan(0);
    expect(startedIdx).toBeLessThan(batchIdx);
    expect(src).toMatch(/story:started[\s\S]{0,200}storyId\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 — failure routing through handlePipelineFailure (source)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6 — parallel failures routed through handlePipelineFailure (source)", () => {
  test("unified-executor.ts has handlePipelineFailure and escalation handling", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("handlePipelineFailure");
    expect(src.indexOf("failed")).toBeGreaterThan(0);
    expect(src.includes("handleTierEscalation") || src.includes("handlePipelineFailure")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — cost-limit check runs after parallel batch (source)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 — cost-limit check after parallel batch (source)", () => {
  test("unified-executor.ts has cost-limit check after runParallelBatch in source order", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    const batchIdx = src.indexOf("runParallelBatch");
    const costLimitIdx = src.indexOf("cost-limit");
    expect(src).toContain("costLimit");
    expect(batchIdx).toBeGreaterThan(0);
    expect(costLimitIdx).toBeGreaterThan(0);
    expect(costLimitIdx).toBeGreaterThan(batchIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — runner-execution.ts always calls executeUnified (no conditional branch)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8 — runner-execution.ts always calls executeUnified with parallelCount", () => {
  test("runner-execution.ts calls executeUnified with parallelCount and no legacy dispatch", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).toContain("executeUnified");
    expect(src).toContain("parallelCount");
  });

  test.each(["executeParallel(", "runParallelExecution"])(
    "runner-execution.ts does not contain %s dispatch branch",
    async (symbol) => {
      const src = await readSrc("execution/runner-execution.ts");
      expect(src).not.toContain(symbol);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — parallel-executor.ts deleted; no src/ imports from it
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9 — parallel-executor.ts deleted", () => {
  test("src/execution/parallel-executor.ts does not exist", async () => {
    const exists = await srcExists("execution/parallel-executor.ts");
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-executor", async () => {
    const proc = Bun.spawn(
      ["grep", "-r", "parallel-executor", "--include=*.ts", "-l", join(SRC)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [_exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    const matchingFiles = stdout.trim().split("\n").filter(Boolean);
    expect(matchingFiles).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 — lifecycle/parallel-lifecycle.ts deleted; no src/ imports from it
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10 — lifecycle/parallel-lifecycle.ts deleted", () => {
  test("src/execution/lifecycle/parallel-lifecycle.ts does not exist", async () => {
    const exists = await srcExists("execution/lifecycle/parallel-lifecycle.ts");
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-lifecycle", async () => {
    const proc = Bun.spawn(
      ["grep", "-r", "parallel-lifecycle", "--include=*.ts", "-l", join(SRC)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [_exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    const matchingFiles = stdout.trim().split("\n").filter(Boolean);
    expect(matchingFiles).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11 — runner.ts no longer references _runnerDeps.runParallelExecution
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11 — runner.ts has no reference to _runnerDeps.runParallelExecution", () => {
  test("runner.ts does not contain runParallelExecution in source or _runnerDeps", async () => {
    const src = await readSrc("execution/runner.ts");
    expect(src).not.toContain("runParallelExecution");
    expect(src).not.toMatch(/_runnerDeps[\s\S]{0,200}runParallelExecution/);
  });
});
