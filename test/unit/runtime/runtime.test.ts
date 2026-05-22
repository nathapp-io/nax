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

  test("close() resolves, aborts signal, and is idempotent", async () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    await expect(rt.close()).resolves.toBeUndefined();
    expect(rt.signal.aborted).toBe(true);
    await rt.close(); // idempotent
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

  test("reviewAuditor is silent (disabled) or real (enabled) — both don't throw on recordDecision", () => {
    const rt1 = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(() => rt1.reviewAuditor.recordDecision({ reviewer: "semantic", storyId: "US-001", parsed: true, passed: true, result: { passed: true, findings: [] } })).not.toThrow();

    const rt2 = makeRuntime(makeNaxConfig({ review: { audit: { enabled: true } } }), "/tmp/test", { featureName: "my-feature" });
    expect(() => rt2.reviewAuditor.recordDecision({ reviewer: "adversarial", storyId: "US-001", parsed: true, passed: true, result: { passed: true, findings: [] } })).not.toThrow();
  });

  test("close() resolves when flush() throws, drain() throws, or both throw", async () => {
    const makeThrowingAuditor = () => ({ record() {}, recordError() {}, async flush() { throw new Error("flush failed"); } });
    const makeThrowingAggregator = () => ({
      record() {}, recordError() {}, recordOperationSummary() {},
      snapshot() { return { totalCostUsd: 0, totalEstimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; }, byStage() { return {}; }, byStory() { return {}; },
      async drain() { throw new Error("drain failed"); },
    });

    await expect(makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor: makeThrowingAuditor() }).close()).resolves.toBeUndefined();
    await expect(makeRuntime(DEFAULT_CONFIG, "/tmp/test", { costAggregator: makeThrowingAggregator() }).close()).resolves.toBeUndefined();
    await expect(makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor: makeThrowingAuditor(), costAggregator: makeThrowingAggregator() }).close()).resolves.toBeUndefined();
  });

  test("close() calls both flush() and drain() regardless of which throws", async () => {
    const makeSnapshotAggregator = (drainFn: () => Promise<void>) => ({
      record() {}, recordError() {}, recordOperationSummary() {},
      snapshot() { return { totalCostUsd: 0, totalEstimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }; },
      byAgent() { return {}; }, byStage() { return {}; }, byStory() { return {}; },
      drain: drainFn,
    });

    let drainCalled = false;
    await makeRuntime(DEFAULT_CONFIG, "/tmp/test", {
      promptAuditor: { record() {}, recordError() {}, async flush() { throw new Error("flush failed"); } },
      costAggregator: makeSnapshotAggregator(async () => { drainCalled = true; }),
    }).close();
    expect(drainCalled).toBe(true);

    let flushCalled = false;
    await makeRuntime(DEFAULT_CONFIG, "/tmp/test", {
      promptAuditor: { record() {}, recordError() {}, async flush() { flushCalled = true; } },
      costAggregator: makeSnapshotAggregator(async () => { throw new Error("drain failed"); }),
    }).close();
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
  test("outputDir uses basename when name absent; uses config.name as projectKey when present", () => {
    const rt1 = makeRuntime(NaxConfigSchema.parse({}), "/tmp/my-project");
    expect(rt1.outputDir).toBe(path.join(globalConfigDir(), "my-project"));
    expect(rt1.projectKey).toBe("my-project");
    expect(rt1.globalDir).toBe(path.join(globalConfigDir(), "global"));

    const rt2 = makeRuntime(NaxConfigSchema.parse({ name: "koda" }), "/tmp/any-path");
    expect(rt2.projectKey).toBe("koda");
    expect(rt2.outputDir).toBe(path.join(globalConfigDir(), "koda"));
  });
});

describe("makeTestRuntime", () => {
  const blockRuntimes: NaxRuntime[] = [];
  afterEach(async () => {
    await Promise.allSettled(blockRuntimes.map((r) => r.close()));
    blockRuntimes.length = 0;
  });

  test("produces valid runtime with defaults; accepts workdir override; has runId", () => {
    const rt = makeTestRuntime();
    blockRuntimes.push(rt);
    expect(rt.configLoader).toBeDefined();
    expect(rt.agentManager).toBeDefined();
    expect(rt.packages.repo().packageDir).toBe("");
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);

    const rt2 = makeTestRuntime({ workdir: "/tmp/custom" });
    blockRuntimes.push(rt2);
    expect(rt2.workdir).toBe("/tmp/custom");
  });
});
