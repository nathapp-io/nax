import { describe, expect, test } from "bun:test";
import { lintCheckOp } from "@/operations";
import type { LintCheckDeps } from "@/operations";
import type { Finding } from "@/findings";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: { packageDir: "packages/agent", config, select: (sel: any) => sel.select(config) },
  } as any;
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
    expect((lintCheckOp as any).build).toBeUndefined();
    expect((lintCheckOp as any).parse).toBeUndefined();
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
          format: "text" as any,
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
          format: "text" as any,
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
    const deps = makeDeps({ runQualityCommand: async () => { called = true; return passedResult; } });
    const out = await lintCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ commands: {} }),
      deps,
    );
    expect(called).toBe(false);
    expect(out.success).toBe(true);
    expect(out.status).toBe("skipped");
    expect(out.findings).toEqual([]);
  });
});

describe("lintCheckOp — AC10: per-package config override", () => {
  test("runs the lint command resolved from packageView", async () => {
    let seen = "";
    const deps = makeDeps({ runQualityCommand: async (o) => { seen = o.command; return passedResult; } });
    await lintCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ commands: { lint: "ruff check packages/agent" } }),
      deps,
    );
    expect(seen).toBe("ruff check packages/agent");
  });
});
