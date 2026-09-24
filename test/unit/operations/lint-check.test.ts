import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { DeepPartial } from "@test/helpers";
import { cleanupTempDir, makeConfigSlice, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector, NaxConfig, QualityConfig } from "@/config";
import type { Finding } from "@/findings";
import type { CallContext, LintCheckDeps, LintCheckOutput } from "@/operations";
import { lintCheckOp } from "@/operations";
import { _commandDefaultsDeps, clearCommandDefaultsCache } from "@/quality";
import type { ToolDiagnosticsScratchEntry } from "@/session/scratch-writer";

function ctxWithQuality(
  quality?: DeepPartial<QualityConfig>,
  opts: { hasOverride?: boolean; repoRoot?: string; overlay?: Partial<NaxConfig> } = {},
): CallContext {
  const config = makeNaxConfig({ quality });
  return {
    runtime: makeTestRuntime({ config }),
    storyId: "US-003",
    packageDir: "packages/agent",
    agentName: "claude",
    packageView: {
      packageDir: "packages/agent",
      relativeFromRoot: "packages/agent",
      repoRoot: opts.repoRoot ?? "/repo",
      hasOverride: opts.hasOverride ?? false,
      ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
      config,
      select: <C>(selector: ConfigSelector<C>): C => selector.select(config),
    },
  };
}

/**
 * A raw per-package overlay declaring exactly the given `quality.commands` —
 * the shape `.nax/mono/<pkg>/config.json` produces before merging.
 */
function rawOverlay(commands: Partial<NonNullable<NaxConfig["quality"]>["commands"]>): Partial<NaxConfig> {
  return { quality: makeConfigSlice("quality", { commands }) };
}

const passedResult = {
  commandName: "lint",
  command: "bun run lint",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

const failedResult = {
  commandName: "lint",
  command: "bun run lint",
  success: false,
  exitCode: 1,
  output: "error output",
  durationMs: 50,
  timedOut: false,
};

const mockFinding: Finding = {
  source: "lint",
  severity: "error",
  category: "lint-error",
  message: "No unused vars",
  file: "src/foo.ts",
  line: 1,
};

function makeDeps(overrides: Partial<LintCheckDeps> = {}): LintCheckDeps {
  return {
    runQualityCommand: async () => passedResult,
    parseLintOutput: () => null,
    ...overrides,
  };
}

const failedLintDiagResult = {
  commandName: "lint",
  command: "bun run lint",
  success: false,
  exitCode: 1,
  output: "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

function makeFailedLintDeps(overrides: Partial<LintCheckDeps> = {}): LintCheckDeps {
  return {
    runQualityCommand: async () => failedLintDiagResult,
    parseLintOutput: () => null,
    ...overrides,
  };
}

describe("lintCheckOp — AC2: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(lintCheckOp.kind).toBe("deterministic");
  });

  test("name is lint-check", () => {
    expect(lintCheckOp.name).toBe("lint-check");
  });

  test("has execute function, not build/parse", () => {
    expect(typeof lintCheckOp.execute).toBe("function");
    expect("build" in lintCheckOp).toBe(false);
    expect("parse" in lintCheckOp).toBe(false);
  });
});

describe("lintCheckOp — AC3: execute returns success=true when command exits 0", () => {
  test("AC3: returns success=true and findings=[] when lint command exits 0", async () => {
    const out = await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      makeDeps({ runQualityCommand: async () => passedResult }),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("AC3: returns success=false and non-empty findings when lint command exits non-zero", async () => {
    const out = await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseLintOutput: () => ({
          format: "text-block",
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  test("AC3: every finding has source='lint' when command exits non-zero", async () => {
    const out = await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseLintOutput: () => ({
          format: "text-block",
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.findings.every((f) => f.source === "lint")).toBe(true);
  });
});

describe("lintCheckOp — AC6: skip-with-warning when no lint command configured", () => {
  test("skips with success+warning when no lint command is configured (no false command)", async () => {
    let called = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        called = true;
        return passedResult;
      },
    });
    const out = await lintCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: {} }), deps);
    expect(called).toBe(false);
    expect(out.success).toBe(true);
    expect(out.status).toBe("skipped");
    expect(out.findings).toEqual([]);
  });
});

describe("lintCheckOp — AC10: per-package config override", () => {
  test("runs the lint command resolved from packageView", async () => {
    let seen = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seen = o.command as string;
        return passedResult;
      },
    });
    await lintCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "ruff check packages/agent" } }),
      deps,
    );
    expect(seen).toBe("ruff check packages/agent");
  });
});

describe("lintCheckOp — workdir routing: repoRoot vs packageDir", () => {
  test("uses repoRoot as cwd when no per-package override (root config fallback)", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await lintCheckOp.execute(
      { workdir: "/repo/packages/app", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }, { hasOverride: false, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo");
  });

  test("uses input.workdir (packageDir) as cwd when the overlay declares quality.commands.lint", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await lintCheckOp.execute(
      { workdir: "/repo/packages/lib", storyId: "US-003" },
      ctxWithQuality(
        { commands: { lint: "echo ok" } },
        { hasOverride: true, repoRoot: "/repo", overlay: rawOverlay({ lint: "echo ok" }) },
      ),
      deps,
    );
    expect(seenWorkdir).toBe("/repo/packages/lib");
  });

  test("US-002 AC11: uses repoRoot as cwd when the overlay declares only quality.commands.test (root lint command)", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await lintCheckOp.execute(
      { workdir: "/r/packages/lib", storyId: "US-003" },
      ctxWithQuality(
        { commands: { lint: "bun run lint" } },
        { hasOverride: true, repoRoot: "/r", overlay: rawOverlay({ test: "bun test" }) },
      ),
      deps,
    );
    expect(seenWorkdir).toBe("/r");
  });
});

describe("lintCheckOp — sentinel affordances", () => {
  test("a DECLARED command offers the RunCommand key and the shell string", async () => {
    const result = await lintCheckOp.execute(
      { storyId: "US-003", workdir: "/repo" },
      ctxWithQuality({ commands: { lint: "bun run lint" } }),
      makeDeps({ runQualityCommand: async () => failedResult, parseLintOutput: () => null }),
    );
    const message = result.findings[0]?.message ?? "";
    expect(message).toContain('RunCommand {"command": "lint"}');
    expect(message).toContain("bun run lint");
  });

  test("an AUTO-DETECTED command never names a RunCommand key", async () => {
    const origDetect = _commandDefaultsDeps.detectLanguage;
    _commandDefaultsDeps.detectLanguage = async () => "go";
    clearCommandDefaultsCache();
    try {
      const result = await lintCheckOp.execute(
        { storyId: "US-003", workdir: "/repo" },
        ctxWithQuality({ commands: {} }),
        makeDeps({ runQualityCommand: async () => failedResult, parseLintOutput: () => null }),
      );
      const message = result.findings[0]?.message ?? "";
      expect(message).toContain("go vet ./...");
      expect(message).not.toContain("RunCommand");
    } finally {
      _commandDefaultsDeps.detectLanguage = origDetect;
      clearCommandDefaultsCache();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 lintCheckOp — tool-diagnostics scratch capture
//
// AC11 — a lint command returning non-zero triggers a tool-diagnostics
//        entry to be appended to the story scratch dir.
// AC12 — when the capture throws, the surrounding lint operation still
//        completes and reports its normal result (best-effort: capture
//        never blocks stage execution).
//
// The capture lives behind an optional `sessionScratchDir` +
// `appendScratchEntry` dep pair on `LintCheckDeps`. Tests inject mocks so
// the test stays hermetic (no real filesystem, no real lint binary).
// ─────────────────────────────────────────────────────────────────────────────

describe("lintCheckOp — tool-diagnostics scratch capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-lint-tool-diag-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("lintCheckOp — AC11: tool-diagnostics capture on non-zero lint exit", () => {
    test("AC11: non-zero lint exit triggers appendScratchEntry with kind=tool-diagnostics to sessionScratchDir", async () => {
      const scratchDir = join(tmpDir, "sess-ac11");
      const appendSpy = mock(async (_dir: string, _entry: ToolDiagnosticsScratchEntry) => undefined);

      const out = await lintCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { lint: "bun run lint" } }),
        makeFailedLintDeps({
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
        }),
      );

      expect(appendSpy).toHaveBeenCalledTimes(1);
      const [calledDir, calledEntry] = appendSpy.mock.calls[0];
      expect(calledDir).toBe(scratchDir);
      expect(calledEntry.kind).toBe("tool-diagnostics");
      expect(calledEntry.storyId).toBe("US-003");
      expect(typeof calledEntry.timestamp).toBe("string");
      expect(Array.isArray(calledEntry.diagnostics)).toBe(true);
      expect(out.success).toBe(false);
    });

    test("AC11: zero lint exit does NOT trigger tool-diagnostics capture", async () => {
      const scratchDir = join(tmpDir, "sess-ac11-pass");
      const appendSpy = mock(async (_dir: string, _entry: ToolDiagnosticsScratchEntry) => undefined);

      const out = await lintCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { lint: "bun run lint" } }),
        {
          runQualityCommand: async () => passedResult,
          parseLintOutput: () => null,
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as LintCheckDeps["appendScratchEntry"],
        },
      );

      expect(appendSpy).toHaveBeenCalledTimes(0);
      expect(out.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC12: append throws → surrounding execution still completes (best-effort)
  // ───────────────────────────────────────────────────────────────────────────

  describe("lintCheckOp — AC12: capture is best-effort", () => {
    test("AC12: appendScratchEntry throwing does not propagate — op still completes and returns its normal result", async () => {
      const scratchDir = join(tmpDir, "sess-ac12");
      const appendSpy = mock(async () => {
        throw new Error("disk full");
      });

      // The op must NOT throw even though capture throws. It must still return
      // its normal failure result (success=false because the lint command failed)
      // so the calling pipeline can keep routing.
      let out: LintCheckOutput | undefined;
      let threw = false;
      try {
        out = await lintCheckOp.execute(
          { workdir: "/tmp", storyId: "US-003" },
          ctxWithQuality({ commands: { lint: "bun run lint" } }),
          {
            runQualityCommand: async () => failedLintDiagResult,
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
      expect(out?.success).toBe(false);
      expect(out?.findings.length).toBeGreaterThan(0);
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    test("AC12: capture skipped entirely (no sessionScratchDir wired) — op still completes normally", async () => {
      const appendSpy = mock(async () => {
        throw new Error("should not be called");
      });

      // No sessionScratchDir → no capture call → op completes normally.
      const out = await lintCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { lint: "bun run lint" } }),
        {
          runQualityCommand: async () => failedLintDiagResult,
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
});
