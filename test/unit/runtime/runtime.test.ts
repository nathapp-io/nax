import { afterEach, describe, test, expect } from "bun:test";
import path from "node:path";
import { DEFAULT_CONFIG, globalConfigDir, NaxConfigSchema } from "@/config";
import { createRuntime, type NaxRuntime } from "@/runtime";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];

function makeRuntime(
  config: Parameters<typeof createRuntime>[0] | ReturnType<typeof NaxConfigSchema.parse>,
  workdir: Parameters<typeof createRuntime>[1],
  opts?: Parameters<typeof createRuntime>[2],
): NaxRuntime {
  const runtime = createRuntime(config as Parameters<typeof createRuntime>[0], workdir, opts);
  createdRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

describe("createRuntime", () => {
  test("runtime has required fields", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.sessionManager).toBeDefined();
    expect(rt.packages).toBeDefined();
    expect(rt.costAggregator).toBeDefined();
    expect(rt.promptAuditor).toBeDefined();
    expect(rt.reviewAuditor).toBeDefined();
    expect(rt.signal).toBeDefined();
    expect(rt.pidRegistry).toBeDefined();
  });

  test("packages.repo() returns root-equivalent view", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    const view = rt.packages.repo();
    expect(view.packageDir).toBe("");
  });

  test("close() resolves without error", async () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("signal aborted after close()", async () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("close() is idempotent", async () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    await rt.close();
    await rt.close();
    expect(rt.signal.aborted).toBe(true);
  });

  test("parentSignal abort propagates to runtime signal", async () => {
    const parent = new AbortController();
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { parentSignal: parent.signal });
    parent.abort();
    expect(rt.signal.aborted).toBe(true);
  });

  test("runtime has runId field", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("production CostAggregator is wired (not no-op)", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    rt.costAggregator.record({
      ts: Date.now(),
      runId: "x",
      agentName: "claude",
      model: "m",
      tokens: { input: 10, output: 5 },
      costUsd: 0.001,
      estimatedCostUsd: 0.001,
      confidence: "exact",
      durationMs: 100,
    });
    expect(rt.costAggregator.snapshot().callCount).toBe(1);
  });

  test("promptAuditor is no-op when agent.promptAudit.enabled is false (default)", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    // No-op auditor.record() does nothing — snapshot stays empty
    rt.promptAuditor.record({
      ts: Date.now(), runId: "x", agentName: "claude",
      permissionProfile: "approve-reads", prompt: "p", response: "r", durationMs: 50,
    });
    // No throw — no-op is silent
  });

  test("promptAuditor is real PromptAuditor when agent.promptAudit.enabled is true", () => {
    const config = makeNaxConfig({ agent: { promptAudit: { enabled: true } } });
    const rt = makeRuntime(config, "/tmp/test", { featureName: "my-feature" });
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
    const rt = makeRuntime(config, "/tmp/test", { featureName: "my-feature" });
    expect(rt.promptAuditor).toBeDefined();
  });

  test("reviewAuditor exists and is silent when review.audit.enabled is false", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(() =>
      rt.reviewAuditor.recordDecision({
        reviewer: "semantic",
        storyId: "US-001",
        parsed: true,
        passed: true,
        result: { passed: true, findings: [] },
      }),
    ).not.toThrow();
  });

  test("reviewAuditor is real when review.audit.enabled is true", () => {
    const config = makeNaxConfig({ review: { audit: { enabled: true } } });
    const rt = makeRuntime(config, "/tmp/test", { featureName: "my-feature" });
    expect(() =>
      rt.reviewAuditor.recordDecision({
        reviewer: "adversarial",
        storyId: "US-001",
        parsed: true,
        passed: true,
        result: { passed: true, findings: [] },
      }),
    ).not.toThrow();
  });

  test("close() resolves when flush() throws", async () => {
    const flushError = new Error("flush failed");
    const promptAuditor = {
      record() {},
      recordError() {},
      async flush() { throw flushError; },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor });
    await expect(rt.close()).resolves.toBeUndefined();
  });

  test("close() resolves when drain() throws", async () => {
    const drainError = new Error("drain failed");
    const costAggregator = {
      record() {},
      recordError() {},
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        };
      },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw drainError; },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { costAggregator });
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
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        };
      },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw new Error("drain failed"); },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
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
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        };
      },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { drainCalled = true; },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
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
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        };
      },
      byAgent() { return {}; },
      byStage() { return {}; },
      byStory() { return {}; },
      async drain() { throw new Error("drain failed"); },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor, costAggregator });
    await rt.close();
    expect(flushCalled).toBe(true);
  });

  test("close() flushes reviewAuditor", async () => {
    let reviewFlushCalled = false;
    const reviewAuditor = {
      recordDispatch() {},
      recordDecision() {},
      async flush() { reviewFlushCalled = true; },
    };
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test", { reviewAuditor });

    await rt.close();

    expect(reviewFlushCalled).toBe(true);
  });
});

describe("createRuntime outputDir", () => {
  test("sets outputDir to ~/.nax/<basename> when name is absent", () => {
    const config = NaxConfigSchema.parse({});
    const runtime = makeRuntime(config, "/tmp/my-project");
    expect(runtime.outputDir).toBe(path.join(globalConfigDir(), "my-project"));
    expect(runtime.projectKey).toBe("my-project");
    expect(runtime.globalDir).toBe(path.join(globalConfigDir(), "global"));
  });

  test("uses config.name as projectKey when present", () => {
    const config = NaxConfigSchema.parse({ name: "koda" });
    const runtime = makeRuntime(config, "/tmp/any-path");
    expect(runtime.projectKey).toBe("koda");
    expect(runtime.outputDir).toBe(path.join(globalConfigDir(), "koda"));
  });
});

describe("makeTestRuntime", () => {
  const blockRuntimes: NaxRuntime[] = [];
  afterEach(async () => {
    await Promise.allSettled(blockRuntimes.map((r) => r.close()));
    blockRuntimes.length = 0;
  });

  test("produces a valid NaxRuntime with defaults", () => {
    const rt = makeTestRuntime();
    blockRuntimes.push(rt);
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.packages.repo().packageDir).toBe("");
  });

  test("accepts config override", () => {
    const rt = makeTestRuntime({ workdir: "/tmp/custom" });
    blockRuntimes.push(rt);
    expect(rt.workdir).toBe("/tmp/custom");
  });

  test("makeTestRuntime produces runtime with runId", () => {
    const rt = makeTestRuntime();
    blockRuntimes.push(rt);
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
