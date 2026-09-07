import { describe, expect, test } from "bun:test";
import type { DeepPartial } from "@test/helpers";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector, QualityConfig } from "@/config";
import type { Finding } from "@/findings";
import type { CallContext, TypecheckCheckDeps } from "@/operations";
import { typecheckCheckOp } from "@/operations";
import { _commandDefaultsDeps, clearCommandDefaultsCache } from "@/quality";

function ctxWithQuality(
  quality?: DeepPartial<QualityConfig>,
  opts: { hasOverride?: boolean; repoRoot?: string } = {},
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
      config,
      select: <C>(selector: ConfigSelector<C>): C => selector.select(config),
    },
  };
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

  test("uses input.workdir (packageDir) as cwd when per-package override exists", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await typecheckCheckOp.execute(
      { workdir: "/repo/packages/lib", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "tsc --noEmit" } }, { hasOverride: true, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo/packages/lib");
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

    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: {} }),
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("skipped");
    expect(out.findings).toEqual([]);
    expect(out.durationMs).toBe(0);
    expect(runQualityCalled).toBe(false);
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
