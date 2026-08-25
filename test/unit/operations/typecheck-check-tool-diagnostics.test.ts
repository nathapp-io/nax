/**
 * US-001 typecheckCheckOp — tool-diagnostics scratch capture
 *
 * AC11 — a typecheck command returning non-zero triggers a tool-diagnostics
 *        entry to be appended to the story scratch dir.
 * AC12 — when the capture throws, the surrounding typecheck operation still
 *        completes and reports its normal result (best-effort: capture
 *        never blocks stage execution).
 *
 * The capture lives behind an optional `sessionScratchDir` +
 * `appendScratchEntry` dep pair on `TypecheckCheckDeps`. Tests inject mocks so
 * the test stays hermetic (no real filesystem, no real tsc binary).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { TypecheckCheckDeps } from "@/operations";
import { typecheckCheckOp } from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-typecheck-tool-diag-");
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

const failedTypecheckResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: false,
  exitCode: 2,
  output: "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

const passedTypecheckResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

function makeDeps(overrides: Partial<TypecheckCheckDeps> = {}): TypecheckCheckDeps {
  return {
    runQualityCommand: async () => failedTypecheckResult,
    parseTypecheckOutput: () => null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC11: failed typecheck → tool-diagnostics entry appended to story scratch dir
// ─────────────────────────────────────────────────────────────────────────────

describe("typecheckCheckOp — AC11: tool-diagnostics capture on non-zero typecheck exit", () => {
  test("AC11: non-zero typecheck exit triggers appendScratchEntry with kind=tool-diagnostics to sessionScratchDir", async () => {
    const scratchDir = join(tmpDir, "sess-ac11");
    const appendSpy = mock(async (_dir: string, _entry: unknown) => undefined);

    const out = await (typecheckCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      makeDeps({
        sessionScratchDir: scratchDir,
        appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
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

  test("AC11: zero typecheck exit does NOT trigger tool-diagnostics capture", async () => {
    const scratchDir = join(tmpDir, "sess-ac11-pass");
    const appendSpy = mock(async (_dir: string, _entry: unknown) => undefined);

    const out = await (typecheckCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      {
        runQualityCommand: async () => passedTypecheckResult,
        parseTypecheckOutput: () => null,
        sessionScratchDir: scratchDir,
        appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
      },
    );

    expect(appendSpy).toHaveBeenCalledTimes(0);
    expect(out.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: capture is best-effort
// ─────────────────────────────────────────────────────────────────────────────

describe("typecheckCheckOp — AC12: capture is best-effort", () => {
  test("AC12: appendScratchEntry throwing does not propagate — op still completes and returns its normal result", async () => {
    const scratchDir = join(tmpDir, "sess-ac12");
    const appendSpy = mock(async () => {
      throw new Error("disk full");
    });

    let out: any;
    let threw = false;
    try {
      out = await (typecheckCheckOp as any).execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
        {
          runQualityCommand: async () => failedTypecheckResult,
          parseTypecheckOutput: () => null,
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
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

    const out = await (typecheckCheckOp as any).execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      {
        runQualityCommand: async () => failedTypecheckResult,
        parseTypecheckOutput: () => null,
        // sessionScratchDir intentionally omitted
        appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
      },
    );

    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(appendSpy).toHaveBeenCalledTimes(0);
  });
});
