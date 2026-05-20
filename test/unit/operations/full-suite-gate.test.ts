import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp, _fullSuiteGateDeps } from "@/operations";

// Helper to create a mock CallContext
const mockCtx = { runtime: {}, storyId: "US-001" } as any;

// Helper to make test deps that mock the test runner and rectification loop
function makeDeps(overrides = {}) {
  return {
    runTests: async () => ({ passed: true, failed: 0, output: "" }),
    runRectificationLoop: async () => ({ exhausted: false, attempts: 0, fixedAll: true }),
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

describe("fullSuiteGateOp — test execution logic", () => {
  test("returns success=true, status=passed when tests pass on first run", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp" },
      mockCtx,
      makeDeps({ runTests: async () => ({ passed: true, failed: 0, output: "" }) }),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.passed).toBe(true);
    expect(out.attempts).toBe(0);
  });

  test("returns success=false, status=failed-no-rectification when tests fail and rectification disabled", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp", rectificationEnabled: false },
      mockCtx,
      makeDeps({ runTests: async () => ({ passed: false, failed: 3, output: "3 tests failed" }) }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed-no-rectification");
    expect(out.passed).toBe(false);
    // Regression guard: must NOT be "disabled"
    expect(out.status).not.toBe("disabled");
  });

  test("returns success=true when tests pass AND rectification disabled (regression check)", async () => {
    // This is the critical regression: OLD code returned success=false,status=disabled even when tests pass.
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp", rectificationEnabled: false },
      mockCtx,
      makeDeps({ runTests: async () => ({ passed: true, failed: 0, output: "" }) }),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    // Old bug was returning success=false here
    expect(out.success).not.toBe(false);
  });

  test("invokes rectification loop when tests fail and rectificationEnabled=true", async () => {
    let rectCalled = false;
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp", rectificationEnabled: true },
      mockCtx,
      makeDeps({
        runTests: async () => ({ passed: false, failed: 2, output: "2 tests failed" }),
        runRectificationLoop: async () => { rectCalled = true; return { exhausted: false, attempts: 1, fixedAll: true }; },
      }),
    );
    expect(rectCalled).toBe(true);
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.attempts).toBe(1);
  });

  test("returns rectification-exhausted when loop exhausts", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp", rectificationEnabled: true },
      mockCtx,
      makeDeps({
        runTests: async () => ({ passed: false, failed: 5, output: "5 tests failed" }),
        runRectificationLoop: async () => ({ exhausted: true, attempts: 3, fixedAll: false }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("rectification-exhausted");
    expect(out.passed).toBe(false);
    expect(out.attempts).toBe(3);
  });

  test("does NOT call rectification loop when tests pass", async () => {
    let rectCalled = false;
    await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", featureName: "f", projectDir: "/tmp", rectificationEnabled: true },
      mockCtx,
      makeDeps({
        runTests: async () => ({ passed: true, failed: 0, output: "" }),
        runRectificationLoop: async () => { rectCalled = true; return { exhausted: false, attempts: 0 }; },
      }),
    );
    expect(rectCalled).toBe(false);
  });
});

describe("fullSuiteGateOp — _fullSuiteGateDeps exported for testability", () => {
  test("_fullSuiteGateDeps is exported and has runTests and runRectificationLoop", () => {
    expect(typeof _fullSuiteGateDeps.runTests).toBe("function");
    expect(typeof _fullSuiteGateDeps.runRectificationLoop).toBe("function");
  });
});
