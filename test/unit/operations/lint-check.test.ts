import { describe, expect, test } from "bun:test";
import { lintCheckOp } from "@/operations";
import type { LintCheckDeps } from "@/operations";
import type { Finding } from "@/findings";

const mockCtx = { runtime: {}, storyId: "US-003" } as any;

const passedResult = {
  commandName: "lintCheck",
  command: "bun run lint",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

const failedResult = {
  commandName: "lintCheck",
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
      mockCtx,
      makeDeps({ runQualityCommand: async () => passedResult }),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("AC3: returns success=false and non-empty findings when lint command exits non-zero", async () => {
    const out = await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
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
      mockCtx,
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

describe("lintCheckOp — AC6: no-command early return", () => {
  test("AC6: returns success=true, findings=[], durationMs=0 when lint command is undefined", async () => {
    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const ctxWithNoLintCommand = {
      ...mockCtx,
      config: { quality: { commands: { lintCheck: undefined } } },
    };

    const out = await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithNoLintCommand,
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.durationMs).toBe(0);
    expect(runQualityCalled).toBe(false);
  });
});

describe("lintCheckOp — AC10: per-package config override", () => {
  test("AC10: uses the command from the config slice (not hardcoded)", async () => {
    let capturedCommand: string | undefined;
    const deps = makeDeps({
      runQualityCommand: async (opts) => {
        capturedCommand = opts.command;
        return passedResult;
      },
    });

    const ctxWithOverride = {
      ...mockCtx,
      config: { quality: { commands: { lintCheck: "custom-lint-command" } } },
    };

    await lintCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithOverride,
      deps,
    );
    expect(capturedCommand).toBe("custom-lint-command");
  });
});
