import { describe, expect, test } from "bun:test";
import { verifyScopedOp } from "@/operations";
import type { VerifyScopedDeps } from "@/operations";
import type { Finding } from "@/findings";

const mockCtx = { runtime: {}, storyId: "US-003" } as any;

const passedResult = {
  commandName: "test",
  command: "bun test",
  success: true,
  exitCode: 0,
  output: "All tests passed",
  durationMs: 100,
  timedOut: false,
};

const failedResult = {
  commandName: "test",
  command: "bun test",
  success: false,
  exitCode: 1,
  output: "1 test failed",
  durationMs: 100,
  timedOut: false,
};

const mockFinding: Finding = {
  source: "test-runner",
  severity: "error",
  category: "failed-test",
  message: "Expected true to be false",
  file: "test/unit/foo.test.ts",
  rule: "my test",
};

function makeDeps(overrides: Partial<VerifyScopedDeps> = {}): VerifyScopedDeps {
  return {
    runQualityCommand: async () => passedResult,
    parseTestOutput: () => ({ passed: 5, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    ...overrides,
  };
}

describe("verifyScopedOp — AC2: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(verifyScopedOp.kind).toBe("deterministic");
  });

  test("name is verify-scoped", () => {
    expect(verifyScopedOp.name).toBe("verify-scoped");
  });

  test("has execute function, not build/parse", () => {
    expect(typeof verifyScopedOp.execute).toBe("function");
    expect((verifyScopedOp as any).build).toBeUndefined();
    expect((verifyScopedOp as any).parse).toBeUndefined();
  });
});

describe("verifyScopedOp — AC5: execute returns success=true when test command exits 0", () => {
  test("AC5: returns success=true and findings=[] when test command exits 0", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({ runQualityCommand: async () => passedResult }),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("AC5: returns success=false and non-empty findings when test command exits non-zero", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTestOutput: () => ({
          passed: 0,
          failed: 1,
          failures: [{ file: "test/unit/foo.test.ts", testName: "my test", error: "Expected true to be false", stackTrace: [] }],
        }),
        testSummaryToFindings: () => [mockFinding],
      }),
    );
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  test("AC5: every finding has source='test-runner' when test command exits non-zero", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTestOutput: () => ({
          passed: 0,
          failed: 1,
          failures: [{ file: "test/unit/foo.test.ts", testName: "my test", error: "Expected", stackTrace: [] }],
        }),
        testSummaryToFindings: () => [mockFinding],
      }),
    );
    expect(out.findings.every((f) => f.source === "test-runner")).toBe(true);
  });
});

describe("verifyScopedOp — AC6: no-command early return", () => {
  test("AC6: returns success=true, findings=[], durationMs=0 when test command is undefined", async () => {
    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const ctxWithNoCommand = {
      ...mockCtx,
      config: { quality: { commands: { test: undefined } } },
    };

    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithNoCommand,
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.durationMs).toBe(0);
    expect(runQualityCalled).toBe(false);
  });
});
