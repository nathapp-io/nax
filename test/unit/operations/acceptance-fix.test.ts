import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { AcceptanceFixSourceInput, AcceptanceFixTestInput } from "@/operations/acceptance-fix";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "@/operations/acceptance-fix";

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
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceFixSourceOp.config) };
}

function makeTestCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceFixTestOp.config) };
}

describe("acceptanceFixSourceOp shape", () => {
  test("kind, name, session role/lifetime, and stage are correct", () => {
    expect(acceptanceFixSourceOp.kind).toBe("run");
    expect(acceptanceFixSourceOp.name).toBe("acceptance-fix-source");
    expect(acceptanceFixSourceOp.session.role).toBe("source-fix");
    expect(acceptanceFixSourceOp.session.lifetime).toBe("fresh");
    expect(acceptanceFixSourceOp.stage).toBe("acceptance");
  });
  test("timeoutMs resolves from execution.sessionTimeoutSeconds", () => {
    const ctx = makeSourceCtx();
    const timeoutMs = acceptanceFixSourceOp.timeoutMs?.(SOURCE_INPUT, ctx);
    expect(timeoutMs).toBe((ctx.config.execution.sessionTimeoutSeconds ?? 0) * 1000);
  });
  test("model resolves from acceptance.fix.fixModel", () => {
    const config = makeNaxConfig({ acceptance: { fix: { fixModel: { agent: "opencode", model: "opencode-go/minimax-m2.7" } } } });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceFixSourceOp.config) };
    expect(acceptanceFixSourceOp.model?.(SOURCE_INPUT, ctx)).toEqual({ agent: "opencode", model: "opencode-go/minimax-m2.7" });
  });
});

describe("acceptanceFixSourceOp.build()", () => {
  test("returns ComposeInput with task containing diagnosis reasoning and test output", () => {
    const ctx = makeSourceCtx();
    const result = acceptanceFixSourceOp.build(SOURCE_INPUT, ctx);
    expect(result).toHaveProperty("task");
    expect(result.task.content).toContain("fn returns wrong value");
    expect(result.task.content).toContain("FAIL: expected true but got false");
  });
});

describe("acceptanceFixSourceOp.parse()", () => {
  test("returns applied: true regardless of output (including empty)", () => {
    const ctx = makeSourceCtx();
    expect(acceptanceFixSourceOp.parse("Fix applied successfully.", SOURCE_INPUT, ctx).applied).toBe(true);
    expect(acceptanceFixSourceOp.parse("", SOURCE_INPUT, ctx).applied).toBe(true);
  });
});

describe("acceptanceFixTestOp shape", () => {
  test("kind, name, session role/lifetime, and stage are correct", () => {
    expect(acceptanceFixTestOp.kind).toBe("run");
    expect(acceptanceFixTestOp.name).toBe("acceptance-fix-test");
    expect(acceptanceFixTestOp.session.role).toBe("test-fix");
    expect(acceptanceFixTestOp.session.lifetime).toBe("fresh");
    expect(acceptanceFixTestOp.stage).toBe("acceptance");
  });
  test("timeoutMs resolves from execution.sessionTimeoutSeconds", () => {
    const ctx = makeTestCtx();
    const timeoutMs = acceptanceFixTestOp.timeoutMs?.(TEST_INPUT, ctx);
    expect(timeoutMs).toBe((ctx.config.execution.sessionTimeoutSeconds ?? 0) * 1000);
  });
  test("model resolves from acceptance.fix.fixModel", () => {
    const config = makeNaxConfig({ acceptance: { fix: { fixModel: { agent: "opencode", model: "opencode-go/minimax-m2.7" } } } });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceFixTestOp.config) };
    expect(acceptanceFixTestOp.model?.(TEST_INPUT, ctx)).toEqual({ agent: "opencode", model: "opencode-go/minimax-m2.7" });
  });
});

describe("acceptanceFixTestOp.build()", () => {
  test("returns ComposeInput with task containing diagnosis reasoning and failedACs", () => {
    const ctx = makeTestCtx();
    const result = acceptanceFixTestOp.build(TEST_INPUT, ctx);
    expect(result).toHaveProperty("task");
    expect(result.task.content).toContain("test imports wrong path");
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
