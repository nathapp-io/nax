import { describe, expect, test } from "bun:test";
import type { DeepPartial } from "@test/helpers";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector, QualityConfig } from "@/config";
import type { Finding } from "@/findings";
import type { CallContext, LintCheckDeps } from "@/operations";
import { lintCheckOp } from "@/operations";

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
        seen = o.command;
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

  test("uses input.workdir (packageDir) as cwd when per-package override exists", async () => {
    let seenWorkdir = "";
    const deps = makeDeps({
      runQualityCommand: async (o) => {
        seenWorkdir = o.workdir;
        return passedResult;
      },
    });
    await lintCheckOp.execute(
      { workdir: "/repo/packages/lib", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "echo ok" } }, { hasOverride: true, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo/packages/lib");
  });
});
