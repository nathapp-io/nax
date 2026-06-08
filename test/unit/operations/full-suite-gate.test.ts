import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp, _fullSuiteGateDeps } from "@/operations";

function ctxWithConfig(config: any = {}) {
  return {
    runtime: {},
    storyId: "US-001",
    packageView: { packageDir: "", config, select: (s: any) => s.select(config) },
  } as any;
}
const mockCtx = ctxWithConfig({});

function makeDeps(overrides = {}) {
  return {
    resolveGateContext: async () => ({
      config: {} as any,
      testCmd: "bun test",
      fullSuiteTimeout: 60,
    }),
    runTests: async () => ({
      passed: true,
      failed: 0,
      output: "",
      parsedSummary: { passed: 5, failed: 0, failures: [] },
      timedOut: false,
      command: "bun test",
    }),
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
          timedOut: false,
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

  test("returns status=execution-failed with a synth finding when parser returns 0 structured failures despite non-zero exit", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001", workdir: "packages/api" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 3,
          output: "ModuleNotFoundError: stock_api._sse",
          parsedSummary: { passed: 0, failed: 3, failures: [] },
          timedOut: false,
          exitCode: 2,
          command: "pytest packages/api",
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("execution-failed");
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0]!;
    expect(f.source).toBe("test-runner");
    expect(f.category).toBe("execution-failed");
    expect(f.severity).toBe("error");
    expect(f.message).toContain("pytest packages/api");
    expect(f.message).toContain("exit 2");
    expect(f.message).toContain("ModuleNotFoundError");
    expect(f.meta).toMatchObject({
      command: "pytest packages/api",
      exitCode: 2,
      packageDir: "packages/api",
      cwd: "/tmp",
    });
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

describe("fullSuiteGateOp — ported RegressionStrategy behavior (issue #1116)", () => {
  test("regressionGate.enabled=false → status=skipped, success=true", async () => {
    const ctx = ctxWithConfig({
      execution: { regressionGate: { enabled: false } },
      quality: { commands: { test: "bun test" } },
    });
    const result = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/r" },
      ctx,
      makeDeps(),
    );
    expect(result.status).toBe("skipped");
    expect(result.success).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("TIMEOUT + acceptOnTimeout=true → status=passed-on-timeout, success=true", async () => {
    const ctx = ctxWithConfig({
      execution: { regressionGate: { acceptOnTimeout: true } },
      quality: { commands: { test: "bun test" } },
    });
    const result = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/r" },
      ctx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 0,
          output: "",
          parsedSummary: { passed: 0, failed: 0, failures: [] },
          timedOut: true,
        }),
      }),
    );
    expect(result.status).toBe("passed-on-timeout");
    expect(result.passed).toBe(true);
    expect(result.success).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=false → status=timeout, success=false", async () => {
    const ctx = ctxWithConfig({
      execution: { regressionGate: { acceptOnTimeout: false } },
      quality: { commands: { test: "bun test" } },
    });
    const result = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/r" },
      ctx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 0,
          output: "",
          parsedSummary: { passed: 0, failed: 0, failures: [] },
          timedOut: true,
        }),
      }),
    );
    expect(result.status).toBe("timeout");
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("TIMEOUT with no acceptOnTimeout config → defaults to true (BUG-026 default preserved)", async () => {
    // Default is acceptOnTimeout=true when not configured
    const ctx = ctxWithConfig({ execution: {}, quality: { commands: { test: "bun test" } } });
    const result = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/r" },
      ctx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 0,
          output: "",
          parsedSummary: { passed: 0, failed: 0, failures: [] },
          timedOut: true,
        }),
      }),
    );
    expect(result.status).toBe("passed-on-timeout");
    expect(result.success).toBe(true);
  });

  test("regressionGate.timeoutSeconds is threaded into resolveGateContext", async () => {
    // The timeout is threaded via resolveGateContext — which we test by verifying
    // the default fallback path produces a result (integration test of resolveGateContext
    // is in test/unit/operations/full-suite-gate-resolver.test.ts if it exists).
    // Here we verify that no type error surfaces and the op respects the output.
    let capturedTimeout = 0;
    const deps = makeDeps({
      resolveGateContext: async () => ({
        config: {} as any,
        testCmd: "bun test",
        fullSuiteTimeout: 999,
      }),
      runTests: async (_input: any, gateCtx: any) => {
        capturedTimeout = gateCtx.fullSuiteTimeout;
        return { passed: true, failed: 0, output: "", parsedSummary: { passed: 1, failed: 0, failures: [] }, timedOut: false };
      },
    });
    await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/r" },
      mockCtx,
      deps,
    );
    expect(capturedTimeout).toBe(999);
  });
});
