/**
 * US-001 lintCheckOp — tool-diagnostics scratch capture
 *
 * AC11 — a lint command returning non-zero triggers a tool-diagnostics
 *        entry to be appended to the story scratch dir.
 * AC12 — when the capture throws, the surrounding lint operation still
 *        completes and reports its normal result (best-effort: capture
 *        never blocks stage execution).
 *
 * The capture lives behind an optional `sessionScratchDir` +
 * `appendScratchEntry` dep pair on `LintCheckDeps`. Tests inject mocks so
 * the test stays hermetic (no real filesystem, no real lint binary).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { lintCheckOp } from "@/operations";
import type { LintCheckDeps } from "@/operations";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-lint-tool-diag-");
});

afterEach(() => {
  cleanupTempDir(tmpDir);
});

function ctxWithQuality(quality?: Record<string, unknown>, opts: { hasOverride?: boolean; repoRoot?: string } = {}) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: {
      packageDir: "packages/agent",
      repoRoot: opts.repoRoot ?? "/repo",
      hasOverride: opts.hasOverride ?? false,
      config,
      select: (sel: any) => sel.select(config),
    },
  } as any;
}

const failedLintResult = {
  commandName: "lint",
  command: "bun run lint",
  success: false,
  exitCode: 1,
  output: "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

const passedLintResult = {
  commandName: "lint",
  command: "bun run lint",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

function makeDeps(overrides: Partial<LintCheckDeps> = {}): LintCheckDeps {
  return {
    runQualityCommand: async () => failedLintResult,
    parseLintOutput: () => null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC11: failed lint → tool-diagnostics entry appended to story scratch dir
// ─────────────────────────────────────────────────────────────────────────────

describe("lintCheckOp — AC11: tool-diagnostics capture on non-zero lint exit", () => {
  test("AC11: non-zero lint exit triggers appendScratchEntry with kind=tool-diagnostics to sessionScratchDir", async () => {
    const scratchDir = join(tmpDir, "sess-ac11");
    const appendSpy = mock(async (_dir: string, _entry: unknown) => undefined);

    const out = await (lintCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      makeDeps({
        sessionScratchDir: scratchDir,
        appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const [calledDir, calledEntry] = appendSpy.mock.calls[0] as [string, any];
    expect(calledDir).toBe(scratchDir);
    expect(calledEntry.kind).toBe("tool-diagnostics");
    expect(calledEntry.storyId).toBe("US-003");
    expect(typeof calledEntry.timestamp).toBe("string");
    expect(Array.isArray(calledEntry.diagnostics)).toBe(true);
    expect(out.success).toBe(false);
  });

  test("AC11: zero lint exit does NOT trigger tool-diagnostics capture", async () => {
    const scratchDir = join(tmpDir, "sess-ac11-pass");
    const appendSpy = mock(async (_dir: string, _entry: unknown) => undefined);

    const out = await (lintCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      {
        runQualityCommand: async () => passedLintResult,
        parseLintOutput: () => null,
        sessionScratchDir: scratchDir,
        appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
      },
    );

    expect(appendSpy).toHaveBeenCalledTimes(0);
    expect(out.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: append throws → surrounding execution still completes (best-effort)
// ─────────────────────────────────────────────────────────────────────────────

describe("lintCheckOp — AC12: capture is best-effort", () => {
  test("AC12: appendScratchEntry throwing does not propagate — op still completes and returns its normal result", async () => {
    const scratchDir = join(tmpDir, "sess-ac12");
    const appendSpy = mock(async () => {
      throw new Error("disk full");
    });

    // The op must NOT throw even though capture throws. It must still return
    // its normal failure result (success=false because the lint command failed)
    // so the calling pipeline can keep routing.
    let out: any;
    let threw = false;
    try {
      out = await (lintCheckOp as any).execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { lint: "bun run lint" } }),
        {
          runQualityCommand: async () => failedLintResult,
          parseLintOutput: () => null,
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
        },
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(out).toBeDefined();
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(appendSpy).toHaveBeenCalledTimes(1);
  });

  test("AC12: capture skipped entirely (no sessionScratchDir wired) — op still completes normally", async () => {
    const appendSpy = mock(async () => {
      throw new Error("should not be called");
    });

    // No sessionScratchDir → no capture call → op completes normally.
    const out = await (lintCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      {
        runQualityCommand: async () => failedLintResult,
        parseLintOutput: () => null,
        // sessionScratchDir intentionally omitted
        appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
      },
    );

    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(appendSpy).toHaveBeenCalledTimes(0);
  });
});
