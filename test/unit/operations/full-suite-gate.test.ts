import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp, _fullSuiteGateDeps } from "@/operations";
import type { Finding } from "@/findings";

const mockCtx = { runtime: {}, storyId: "US-001" } as any;

function makeDeps(overrides = {}) {
  return {
    resolveGateContext: async () => ({
      config: {} as any,
      testCmd: "bun test",
      fullSuiteTimeout: 60,
    }),
    runTests: async () => ({ passed: true, failed: 0, output: "", parsedSummary: { passed: 5, failed: 0, failures: [] } }),
    ...overrides,
  };
}

describe("fullSuiteGateOp — DeterministicOperation shape", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(fullSuiteGateOp.kind).toBe("deterministic");
  });

  test("name is full-suite-gate", () => {
    expect(fullSuiteGateOp.name).toBe("full-suite-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof fullSuiteGateOp.execute).toBe("function");
    expect((fullSuiteGateOp as any).build).toBeUndefined();
    expect((fullSuiteGateOp as any).parse).toBeUndefined();
  });
});

describe("fullSuiteGateOp — test execution logic (US-006)", () => {
  test("returns success=true, status=passed, findings=[] when tests pass", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps(),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.passed).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.attempts).toBe(0);
  });

  test("returns success=false, status=failed, findings populated when tests fail with structured failures", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 2,
          output: "2 tests failed",
          parsedSummary: {
            passed: 0,
            failed: 2,
            failures: [
              { file: "test/a.test.ts", testName: "test A", error: "err A", stackTrace: [] },
              { file: "test/b.test.ts", testName: "test B", error: "err B", stackTrace: [] },
            ],
          },
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.passed).toBe(false);
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0].source).toBe("test-runner");
    expect(out.findings[0].category).toBe("failed-test");
    expect(out.findings[0].rule).toBe("test A");
    // Regression guard: must NOT be old status values
    expect(out.status).not.toBe("failed-no-rectification");
    expect(out.status).not.toBe("rectification-exhausted");
  });

  test("returns status=execution-failed and findings=[] when parser returns 0 structured failures despite non-zero exit", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 3,
          output: "process crashed",
          parsedSummary: { passed: 0, failed: 3, failures: [] },
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("execution-failed");
    expect(out.findings).toEqual([]);
  });

  test("no runRectificationLoop dep exists on _fullSuiteGateDeps (AC-3)", () => {
    expect(((_fullSuiteGateDeps as any).runRectificationLoop)).toBeUndefined();
  });

  test("rectificationEnabled field is not read (removed from FullSuiteGateInput)", async () => {
    // Passing rectificationEnabled should be a type error at compile time,
    // and at runtime the field is simply ignored. This test ensures the op
    // produces the same output regardless of any legacy field value.
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", rectificationEnabled: true } as any,
      mockCtx,
      makeDeps(),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
  });
});
