/**
 * Unit tests for US-003: Unify executors — the executor's public surface.
 *
 * File: unified-executor-signature.test.ts
 * Covers:
 *   AC-1  executeUnified exports SequentialExecutionResult return type
 *   _unifiedExecutorDeps — injectable deps
 *   AC-8  runner-execution.ts always calls executeUnified
 *   AC-9  parallel-executor.ts deleted
 *   AC-10 lifecycle/parallel-lifecycle.ts deleted
 *   AC-11 runner.ts has no reference to _runnerDeps.runParallelExecution
 *
 * The AC-2 to AC-7 and BUG-7 cases here read the parallel dispatch module by
 * path; US-001 deleted that module with the parallel dispatch path.
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
    const mod = await import("@/execution/unified-executor");
    expect((mod as Record<string, unknown>)._unifiedExecutorDeps).toBeDefined();
  });

  test.each(["runIteration"])("_unifiedExecutorDeps contains %s function", async (fnName) => {
    const mod = await import("@/execution/unified-executor");
    const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    expect(typeof deps[fnName]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — runner-execution.ts always calls executeUnified (no conditional branch)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8 — runner-execution.ts always calls executeUnified without parallelCount", () => {
  test("runner-execution.ts calls executeUnified without parallelCount or legacy dispatch", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).toContain("executeUnified");
    // The workflow-only harness omits this property; dispatch tests also check
    // the actual executor context rather than relying only on source shape.
    expect(src).not.toContain("parallelCount");
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
    const proc = Bun.spawn(["grep", "-r", "parallel-executor", "--include=*.ts", "-l", join(SRC)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
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
    const proc = Bun.spawn(["grep", "-r", "parallel-lifecycle", "--include=*.ts", "-l", join(SRC)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
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
