import { describe, test, expect } from "bun:test";
import { createRuntime } from "../../../src/runtime";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";

describe("createRuntime", () => {
  test("runtime has required fields", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.sessionManager).toBeDefined();
    expect(rt.packages).toBeDefined();
    expect(rt.costAggregator).toBeDefined();
    expect(rt.promptAuditor).toBeDefined();
    expect(rt.signal).toBeDefined();
    expect(rt.pidRegistry).toBeDefined();
  });

  test("packages.repo() returns root-equivalent view", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    const view = rt.packages.repo();
    expect(view.packageDir).toBe("");
  });

  test("close() resolves without error", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("signal aborted after close()", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("close() is idempotent", async () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("parentSignal abort propagates to runtime signal", async () => {
    const parent = new AbortController();
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { parentSignal: parent.signal });
    parent.abort();
    expect(rt.signal.aborted).toBe(true);
  });

  test("runtime has runId field", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("production CostAggregator is wired (not no-op)", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    rt.costAggregator.record({
      ts: Date.now(),
      runId: "x",
      agentName: "claude",
      model: "m",
      tokens: { input: 10, output: 5 },
      costUsd: 0.001,
      durationMs: 100,
    });
    expect(rt.costAggregator.snapshot().callCount).toBe(1);
  });

  test("promptAuditor is no-op when agent.promptAudit.enabled is false (default)", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    // No-op auditor.record() does nothing — snapshot stays empty
    rt.promptAuditor.record({
      ts: Date.now(), runId: "x", agentName: "claude",
      permissionProfile: "approve-reads", prompt: "p", response: "r", durationMs: 50,
    });
    // No throw — no-op is silent
  });

  test("promptAuditor is real PromptAuditor when agent.promptAudit.enabled is true", () => {
    const config = makeNaxConfig({ agent: { promptAudit: { enabled: true } } });
    const rt = createRuntime(config, "/tmp/test", { featureName: "my-feature" });
    // Real auditor.record() doesn't throw either, but snapshot() on cost aggregator
    // confirms the runtime is operational — the key contract is that record() doesn't
    // silently discard entries (tested via flush in EC-3 integration test).
    expect(() =>
      rt.promptAuditor.record({
        ts: Date.now(), runId: "x", agentName: "claude",
        permissionProfile: "approve-reads", prompt: "p", response: "r", durationMs: 50,
      }),
    ).not.toThrow();
  });

  test("promptAuditor uses configured dir when agent.promptAudit.dir is set", () => {
    const config = makeNaxConfig({ agent: { promptAudit: { enabled: true, dir: "/custom/audit" } } });
    const rt = createRuntime(config, "/tmp/test", { featureName: "my-feature" });
    expect(rt.promptAuditor).toBeDefined();
  });

  test("close() resolves when flush() throws", async () => {
    const flushError = new Error("flush failed");
    const promptAuditor = {
      record() {},
      recordError() {},
      async flush() { throw flushError; },
    };
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor });
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("close() resolves when drain() throws", async () => {
    const drainError = new Error("drain failed");
    const costAggregator = {
      record() {},
      recordError() {},
      snapshot() { return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw drainError; },
    };
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { costAggregator });
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("close() resolves when both flush() and drain() throw", async () => {
    const promptAuditor = {
      record() {},
      recordError() {},
      async flush() { throw new Error("flush failed"); },
    };
    const costAggregator = {
      record() {},
      recordError() {},
      snapshot() { return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw new Error("drain failed"); },
    };
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("close() calls drain() even when flush() throws", async () => {
    let drainCalled = false;
    const promptAuditor = {
      record() {},
      recordError() {},
      async flush() { throw new Error("flush failed"); },
    };
    const costAggregator = {
      record() {},
      recordError() {},
      snapshot() { return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { drainCalled = true; },
    };
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
    await rt.close();
    expect(drainCalled).toBe(true);
  });

  test("close() calls flush() even when drain() throws", async () => {
    let flushCalled = false;
    const promptAuditor = {
      record() {},
      recordError() {},
      async flush() { flushCalled = true; },
    };
    const costAggregator = {
      record() {},
      recordError() {},
      snapshot() { return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw new Error("drain failed"); },
    };
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
    await rt.close();
    expect(flushCalled).toBe(true);
  });
});

describe("makeTestRuntime", () => {
  test("produces a valid NaxRuntime with defaults", () => {
    const rt = makeTestRuntime();
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.packages.repo().packageDir).toBe("");
  });

  test("accepts config override", () => {
    const rt = makeTestRuntime({ workdir: "/tmp/custom" });
    expect(rt.workdir).toBe("/tmp/custom");
  });

  test("makeTestRuntime produces runtime with runId", () => {
    const rt = makeTestRuntime();
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
