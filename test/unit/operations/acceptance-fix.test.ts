import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import type { AcceptanceFixSourceInput, AcceptanceFixTestInput } from "../../../src/operations/acceptance-fix";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "../../../src/operations/acceptance-fix";

const SOURCE_INPUT: AcceptanceFixSourceInput = {
  testOutput: "FAIL: expected true but got false",
  diagnosisReasoning: "fn returns wrong value — off by one",
  acceptanceTestPath: "/tmp/acceptance.test.ts",
};

const TEST_INPUT: AcceptanceFixTestInput = {
  testOutput: "FAIL: import not found",
  diagnosisReasoning: "test imports wrong path",
  failedACs: ["AC-1", "AC-2"],
  acceptanceTestPath: "/tmp/acceptance.test.ts",
};

function makeSourceCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceFixSourceOp.config) };
}

function makeTestCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceFixTestOp.config) };
}

describe("acceptanceFixSourceOp shape", () => {
  test("kind is run", () => {
    expect(acceptanceFixSourceOp.kind).toBe("run");
  });
  test("name is acceptance-fix-source", () => {
    expect(acceptanceFixSourceOp.name).toBe("acceptance-fix-source");
  });
  test("session.role is source-fix", () => {
    expect(acceptanceFixSourceOp.session.role).toBe("source-fix");
  });
  test("session.lifetime is fresh", () => {
    expect(acceptanceFixSourceOp.session.lifetime).toBe("fresh");
  });
  test("stage is acceptance", () => {
    expect(acceptanceFixSourceOp.stage).toBe("acceptance");
  });
  test("timeoutMs resolves from execution.sessionTimeoutSeconds", () => {
    const ctx = makeSourceCtx();
    const timeoutMs = acceptanceFixSourceOp.timeoutMs?.(SOURCE_INPUT, ctx);
    expect(timeoutMs).toBe((ctx.config.execution.sessionTimeoutSeconds ?? 0) * 1000);
  });
  test("model resolves from acceptance.fix.fixModel", () => {
    const config = makeNaxConfig({
      acceptance: {
        fix: {
          fixModel: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
        },
      },
    });
    const runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceFixSourceOp.config) };

    expect(acceptanceFixSourceOp.model?.(SOURCE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });
});

describe("acceptanceFixSourceOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.build(SOURCE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task section content contains diagnosis reasoning", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.build(SOURCE_INPUT, ctx);
    expect(result.task.content).toContain("fn returns wrong value");
  });
  test("task section content contains test output", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.build(SOURCE_INPUT, ctx);
    expect(result.task.content).toContain("FAIL: expected true but got false");
  });
});

describe("acceptanceFixSourceOp.parse()", () => {
  test("returns applied: true regardless of output", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.parse("Fix applied successfully.", SOURCE_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
  test("returns applied: true even for empty output", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.parse("", SOURCE_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
});

describe("acceptanceFixTestOp shape", () => {
  test("kind is run", () => {
    expect(acceptanceFixTestOp.kind).toBe("run");
  });
  test("name is acceptance-fix-test", () => {
    expect(acceptanceFixTestOp.name).toBe("acceptance-fix-test");
  });
  test("session.role is test-fix", () => {
    expect(acceptanceFixTestOp.session.role).toBe("test-fix");
  });
  test("session.lifetime is fresh", () => {
    expect(acceptanceFixTestOp.session.lifetime).toBe("fresh");
  });
  test("stage is acceptance", () => {
    expect(acceptanceFixTestOp.stage).toBe("acceptance");
  });
  test("timeoutMs resolves from execution.sessionTimeoutSeconds", () => {
    const ctx = makeTestCtx();
    const timeoutMs = acceptanceFixTestOp.timeoutMs?.(TEST_INPUT, ctx);
    expect(timeoutMs).toBe((ctx.config.execution.sessionTimeoutSeconds ?? 0) * 1000);
  });
  test("model resolves from acceptance.fix.fixModel", () => {
    const config = makeNaxConfig({
      acceptance: {
        fix: {
          fixModel: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
        },
      },
    });
    const runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceFixTestOp.config) };

    expect(acceptanceFixTestOp.model?.(TEST_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });
});

describe("acceptanceFixTestOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeTestCtx();
    const result = acceptanceFixTestOp.build(TEST_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task section content contains diagnosis reasoning", () => {
    const ctx = makeTestCtx();
    const result = acceptanceFixTestOp.build(TEST_INPUT, ctx);
    expect(result.task.content).toContain("test imports wrong path");
  });
  test("task section content contains failedACs", () => {
    const ctx = makeTestCtx();
    const result = acceptanceFixTestOp.build(TEST_INPUT, ctx);
    expect(result.task.content).toContain("AC-1");
  });
});

describe("acceptanceFixTestOp.parse()", () => {
  test("returns applied: true regardless of output", () => {
    const ctx = makeTestCtx();
    const result = acceptanceFixTestOp.parse("Fix applied.", TEST_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
});
