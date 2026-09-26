import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { DeepPartial } from "@test/helpers";
import { cleanupTempDir, makeConfigSlice, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector, NaxConfig, QualityConfig } from "@/config";
import type { Finding } from "@/findings";
import type { CallContext, TypecheckCheckDeps, TypecheckCheckOutput } from "@/operations";
import { typecheckCheckOp } from "@/operations";
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
  commandName: "typecheck",
  command: "bun run typecheck",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

const failedResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: false,
  exitCode: 1,
  output: "src/foo.ts(1,1): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

const mockFinding: Finding = {
  source: "typecheck",
  severity: "error",
  category: "typecheck-error",
  message: "Cannot find name 'foo'.",
  file: "src/foo.ts",
  line: 1,
};

function makeDeps(overrides: Partial<TypecheckCheckDeps> = {}): TypecheckCheckDeps {
  return {
    runQualityCommand: async () => passedResult,
    parseTypecheckOutput: () => null,
    ...overrides,
  };
}

const failedTypecheckDiagResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: false,
  exitCode: 2,
  output: "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

function makeFailedTypecheckDeps(overrides: Partial<TypecheckCheckDeps> = {}): TypecheckCheckDeps {
  return {
    runQualityCommand: async () => failedTypecheckDiagResult,
    parseTypecheckOutput: () => null,
    ...overrides,
  };
}

describe("typecheckCheckOp — AC2: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(typecheckCheckOp.kind).toBe("deterministic");
  });

  test("name is typecheck-check", () => {
    expect(typecheckCheckOp.name).toBe("typecheck-check");
  });

  test("has execute function, not build/parse", () => {
    expect(typeof typecheckCheckOp.execute).toBe("function");
    expect("build" in typecheckCheckOp).toBe(false);
    expect("parse" in typecheckCheckOp).toBe(false);
  });
});

describe("typecheckCheckOp — AC4: execute returns success=true when command exits 0", () => {
  test("AC4: returns success=true and findings=[] when typecheck command exits 0", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      makeDeps({ runQualityCommand: async () => passedResult }),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("AC4: returns success=false and non-empty findings when typecheck command exits non-zero", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTypecheckOutput: () => ({
          format: "tsc",
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  test("AC4: every finding has source='typecheck' when command exits non-zero", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTypecheckOutput: () => ({
          format: "tsc",
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.findings.every((f) => f.source === "typecheck")).toBe(true);
  });
});

describe("typecheckCheckOp — workdir routing: repoRoot vs packageDir", () => {
  test("uses repoRoot as cwd when no per-package override (root config fallback)", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await typecheckCheckOp.execute(
      { workdir: "/repo/packages/app", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }, { hasOverride: false, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo");
  });

  test("uses input.workdir (packageDir) as cwd when the overlay declares quality.commands.typecheck", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await typecheckCheckOp.execute(
      { workdir: "/repo/packages/lib", storyId: "US-003" },
      ctxWithQuality(
        { commands: { typecheck: "tsc --noEmit" } },
        { hasOverride: true, repoRoot: "/repo", overlay: rawOverlay({ typecheck: "tsc --noEmit" }) },
      ),
      deps,
    );
    expect(seenWorkdir).toBe("/repo/packages/lib");
  });

  test("US-002 AC13: uses repoRoot as cwd when the overlay declares only quality.commands.test (root typecheck command)", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await typecheckCheckOp.execute(
      { workdir: "/r/packages/lib", storyId: "US-003" },
      ctxWithQuality(
        { commands: { typecheck: "bun run typecheck" } },
        { hasOverride: true, repoRoot: "/r", overlay: rawOverlay({ test: "bun test" }) },
      ),
      deps,
    );
    expect(seenWorkdir).toBe("/r");
  });
});

describe("typecheckCheckOp — AC6: no-command early return", () => {
  test("AC6: returns success=true, findings=[], durationMs=0 when typecheck command is undefined", async () => {
    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });
    // Stub detection instead of reading the real workdir: stray manifests in a
    // shared directory like /tmp would otherwise yield a detected command and
    // turn this "no command" case into a run.
    const origDetect = _commandDefaultsDeps.detectLanguage;
    _commandDefaultsDeps.detectLanguage = async () => undefined;
    clearCommandDefaultsCache();
    try {
      const out = await typecheckCheckOp.execute(
        { workdir: "/repo", storyId: "US-003" },
        ctxWithQuality({ commands: {} }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(out.status).toBe("skipped");
      expect(out.findings).toEqual([]);
      expect(out.durationMs).toBe(0);
      expect(runQualityCalled).toBe(false);
    } finally {
      _commandDefaultsDeps.detectLanguage = origDetect;
      clearCommandDefaultsCache();
    }
  });
});

describe("typecheckCheckOp — sentinel affordances", () => {
  test("a DECLARED command offers the RunCommand key and the shell string", async () => {
    // Key first for native (which has RunCommand and no shell); shell string
    // retained for ACP (which is never given codingTools at all).
    const result = await typecheckCheckOp.execute(
      { storyId: "US-003", workdir: "/repo" },
      ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
      makeDeps({ runQualityCommand: async () => failedResult, parseTypecheckOutput: () => null }),
    );
    const message = result.findings[0]?.message ?? "";
    expect(message).toContain('RunCommand {"command": "typecheck"}');
    expect(message).toContain("bun run typecheck");
  });

  test("an AUTO-DETECTED command never names a RunCommand key", async () => {
    // declaredCommands is built from quality.commands verbatim, so a detected
    // command has no key -- naming one would dead-end on `unknown command`.
    // Go is used because its defaults are toolchain built-ins, returned with no
    // filesystem probing, which keeps the detected branch deterministic here.
    const origDetect = _commandDefaultsDeps.detectLanguage;
    _commandDefaultsDeps.detectLanguage = async () => "go";
    clearCommandDefaultsCache();
    try {
      const result = await typecheckCheckOp.execute(
        { storyId: "US-003", workdir: "/repo" },
        ctxWithQuality({ commands: {} }),
        makeDeps({ runQualityCommand: async () => failedResult, parseTypecheckOutput: () => null }),
      );
      const message = result.findings[0]?.message ?? "";
      expect(message).toContain("go build ./...");
      expect(message).not.toContain("RunCommand");
    } finally {
      _commandDefaultsDeps.detectLanguage = origDetect;
      clearCommandDefaultsCache();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 typecheckCheckOp — tool-diagnostics scratch capture
//
// AC11 — a typecheck command returning non-zero triggers a tool-diagnostics
//        entry to be appended to the story scratch dir.
// AC12 — when the capture throws, the surrounding typecheck operation still
//        completes and reports its normal result (best-effort: capture
//        never blocks stage execution).
//
// The capture lives behind an optional `sessionScratchDir` +
// `appendScratchEntry` dep pair on `TypecheckCheckDeps`. Tests inject mocks so
// the test stays hermetic (no real filesystem, no real tsc binary).
// ─────────────────────────────────────────────────────────────────────────────

describe("typecheckCheckOp — tool-diagnostics scratch capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-typecheck-tool-diag-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("typecheckCheckOp — AC11: tool-diagnostics capture on non-zero typecheck exit", () => {
    test("AC11: non-zero typecheck exit triggers appendScratchEntry with kind=tool-diagnostics to sessionScratchDir", async () => {
      const scratchDir = join(tmpDir, "sess-ac11");
      const appendSpy = mock(async (_dir: string, _entry: ToolDiagnosticsScratchEntry) => undefined);

      const out = await typecheckCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
        makeFailedTypecheckDeps({
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
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

    test("AC11: zero typecheck exit does NOT trigger tool-diagnostics capture", async () => {
      const scratchDir = join(tmpDir, "sess-ac11-pass");
      const appendSpy = mock(async (_dir: string, _entry: ToolDiagnosticsScratchEntry) => undefined);

      const out = await typecheckCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
        {
          runQualityCommand: async () => passedResult,
          parseTypecheckOutput: () => null,
          sessionScratchDir: scratchDir,
          appendScratchEntry: appendSpy as TypecheckCheckDeps["appendScratchEntry"],
        },
      );

      expect(appendSpy).toHaveBeenCalledTimes(0);
      expect(out.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC12: capture is best-effort
  // ───────────────────────────────────────────────────────────────────────────

  describe("typecheckCheckOp — AC12: capture is best-effort", () => {
    test("AC12: appendScratchEntry throwing does not propagate — op still completes and returns its normal result", async () => {
      const scratchDir = join(tmpDir, "sess-ac12");
      const appendSpy = mock(async () => {
        throw new Error("disk full");
      });

      let out: TypecheckCheckOutput | undefined;
      let threw = false;
      try {
        out = await typecheckCheckOp.execute(
          { workdir: "/tmp", storyId: "US-003" },
          ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
          {
            runQualityCommand: async () => failedTypecheckDiagResult,
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
      expect(out?.success).toBe(false);
      expect(out?.findings.length).toBeGreaterThan(0);
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    test("AC12: capture skipped entirely (no sessionScratchDir wired) — op still completes normally", async () => {
      const appendSpy = mock(async () => {
        throw new Error("should not be called");
      });

      const out = await typecheckCheckOp.execute(
        { workdir: "/tmp", storyId: "US-003" },
        ctxWithQuality({ commands: { typecheck: "bun run typecheck" } }),
        {
          runQualityCommand: async () => failedTypecheckDiagResult,
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
});
