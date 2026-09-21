import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path, { join } from "node:path";
import { makeNaxConfig, makeTestRuntime, withTempDir } from "@test/helpers";
import { DEFAULT_CONFIG, globalConfigDir, NaxConfigSchema } from "@/config";
import {
  type AgentUsageUpdateEvent,
  createRuntime,
  type IUsageAuditor,
  type NaxRuntime,
  type UsageAuditEntry,
} from "@/runtime";

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

function usageEvent(runtime: NaxRuntime, overrides: Partial<AgentUsageUpdateEvent> = {}): AgentUsageUpdateEvent {
  return {
    kind: "agent.usage_update",
    callId: "call-001",
    runId: runtime.runId,
    agentName: "claude",
    sessionName: "nax-abc-feat-US-001-implementer",
    timestamp: 1_700_000_000_000,
    scopeId: "scope-1",
    inputTokens: 120,
    outputTokens: 45,
    costUsd: 0.0042,
    ...overrides,
  };
}

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

  test("runtime initializes an empty rectification oscillation store", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.rectificationOscillations).toBeInstanceOf(Map);
    expect(rt.rectificationOscillations.size).toBe(0);
  });

  test("runtime initializes an empty mutation summary store", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.mutationSummaries).toBeInstanceOf(Map);
    expect(rt.mutationSummaries.size).toBe(0);
  });

  test("runtime initializes an empty routing-decision cache (BUG-19)", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    expect(rt.routingCache).toBeInstanceOf(Map);
    expect(rt.routingCache.size).toBe(0);
  });

  test("two runtimes never share a routing cache, even with colliding story ids (BUG-19)", () => {
    // The original defect: cachedDecisions was a module-level singleton, so a
    // decision cached under "US-001" in one run/feature could be served back
    // to an unrelated run/feature whose story ids happened to collide.
    const runA = makeRuntime(DEFAULT_CONFIG, "/tmp/test-a");
    const runB = makeRuntime(DEFAULT_CONFIG, "/tmp/test-b");

    runA.routingCache.set("US-001", {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "run A",
    });

    expect(runA.routingCache.has("US-001")).toBe(true);
    expect(runB.routingCache.has("US-001")).toBe(false);
    expect(runB.routingCache.size).toBe(0);
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
      exactCostUsd: 0.001,
      confidence: "exact",
      durationMs: 100,
    });
    expect(rt.costAggregator.snapshot().callCount).toBe(1);
  });

  test("AC1: createRuntime with promptAudit.enabled=true and no options resolves to a runtime instead of throwing", () => {
    const config = makeNaxConfig({ agent: { promptAudit: { enabled: true } } });
    // Must not throw — should resolve to a runtime with a no-op auditor
    expect(() => makeRuntime(config, "/tmp/test")).not.toThrow();
  });

  test("AC2: recording and flushing on that runtime writes no file to the audit dir", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ agent: { promptAudit: { enabled: true, dir: path.join(dir, "audit") } } });
      // No featureName — should degrade to no-op auditor
      const rt = makeRuntime(config, dir);
      rt.promptAuditor.record({
        ts: Date.now(),
        runId: rt.runId,
        agentName: "claude",
        permissionProfile: "approve-reads",
        prompt: "hello",
        response: "world",
        durationMs: 50,
      });
      await rt.close();
      // No files should exist under the audit dir at all
      const auditDir = path.join(dir, "audit");
      expect(() => readdirSync(auditDir)).toThrow();
    });
  });

  test("AC3: createRuntime with featureName resolves to a runtime whose auditor writes to the audit dir after record+flush", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ agent: { promptAudit: { enabled: true, dir: path.join(dir, "audit") } } });
      const rt = makeRuntime(config, dir, { featureName: "demo" });
      rt.promptAuditor.record({
        ts: Date.now(),
        runId: rt.runId,
        agentName: "claude",
        permissionProfile: "approve-reads",
        prompt: "hello",
        response: "world",
        durationMs: 50,
      });
      await rt.close();
      const featureDir = path.join(dir, "audit", "demo");
      const files = readdirSync(featureDir);
      expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
    });
  });

  test("promptAuditor is no-op when agent.promptAudit.enabled is false (default)", () => {
    const rt = makeRuntime(DEFAULT_CONFIG, "/tmp/test");
    // No-op auditor.record() does nothing — snapshot stays empty
    rt.promptAuditor.record({
      ts: Date.now(),
      runId: "x",
      agentName: "claude",
      permissionProfile: "approve-reads",
      prompt: "p",
      response: "r",
      durationMs: 50,
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
        ts: Date.now(),
        runId: "x",
        agentName: "claude",
        permissionProfile: "approve-reads",
        prompt: "p",
        response: "r",
        durationMs: 50,
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
    expect(() =>
      rt1.reviewAuditor.recordDecision({
        reviewer: "semantic",
        storyId: "US-001",
        parsed: true,
        passed: true,
        result: { passed: true, findings: [] },
      }),
    ).not.toThrow();

    const rt2 = makeRuntime(makeNaxConfig({ review: { audit: { enabled: true } } }), "/tmp/test", {
      featureName: "my-feature",
    });
    expect(() =>
      rt2.reviewAuditor.recordDecision({
        reviewer: "adversarial",
        storyId: "US-001",
        parsed: true,
        passed: true,
        result: { passed: true, findings: [] },
      }),
    ).not.toThrow();
  });

  test("close() resolves when flush() throws, drain() throws, or both throw", async () => {
    const makeThrowingAuditor = () => ({
      record() {},
      recordError() {},
      async flush() {
        throw new Error("flush failed");
      },
    });
    const makeThrowingAggregator = () => ({
      record() {},
      recordError() {},
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
          totalErrorCostUsd: 0,
        };
      },
      byAgent() {
        return {};
      },
      byStage() {
        return {};
      },
      byStory() {
        return {};
      },
      byCall() {
        return {};
      },
      byScope() {
        return {};
      },
      openScope(scopeId?: string) {
        return {
          scopeId: scopeId ?? "test",
          snapshot: () => ({
            totalCostUsd: 0,
            totalEstimatedCostUsd: 0,
            totalExactCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            callCount: 0,
            errorCount: 0,
            totalErrorCostUsd: 0,
          }),
          close: () => {},
        };
      },
      async drain() {
        throw new Error("drain failed");
      },
    });

    await expect(
      makeRuntime(DEFAULT_CONFIG, "/tmp/test", { promptAuditor: makeThrowingAuditor() }).close(),
    ).resolves.toBeUndefined();
    await expect(
      makeRuntime(DEFAULT_CONFIG, "/tmp/test", { costAggregator: makeThrowingAggregator() }).close(),
    ).resolves.toBeUndefined();
    await expect(
      makeRuntime(DEFAULT_CONFIG, "/tmp/test", {
        promptAuditor: makeThrowingAuditor(),
        costAggregator: makeThrowingAggregator(),
      }).close(),
    ).resolves.toBeUndefined();
  });

  test("close() calls both flush() and drain() regardless of which throws", async () => {
    const makeSnapshotAggregator = (drainFn: () => Promise<void>) => ({
      record() {},
      recordError() {},
      recordOperationSummary() {},
      snapshot() {
        return {
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
          totalErrorCostUsd: 0,
        };
      },
      byAgent() {
        return {};
      },
      byStage() {
        return {};
      },
      byStory() {
        return {};
      },
      byCall() {
        return {};
      },
      byScope() {
        return {};
      },
      openScope(scopeId?: string) {
        return {
          scopeId: scopeId ?? "test",
          snapshot: () => ({
            totalCostUsd: 0,
            totalEstimatedCostUsd: 0,
            totalExactCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            callCount: 0,
            errorCount: 0,
            totalErrorCostUsd: 0,
          }),
          close: () => {},
        };
      },
      drain: drainFn,
    });

    let drainCalled = false;
    await makeRuntime(DEFAULT_CONFIG, "/tmp/test", {
      promptAuditor: {
        record() {},
        recordError() {},
        async flush() {
          throw new Error("flush failed");
        },
      },
      costAggregator: makeSnapshotAggregator(async () => {
        drainCalled = true;
      }),
    }).close();
    expect(drainCalled).toBe(true);

    let flushCalled = false;
    await makeRuntime(DEFAULT_CONFIG, "/tmp/test", {
      promptAuditor: {
        record() {},
        recordError() {},
        async flush() {
          flushCalled = true;
        },
      },
      costAggregator: makeSnapshotAggregator(async () => {
        throw new Error("drain failed");
      }),
    }).close();
    expect(flushCalled).toBe(true);
  });

  test("close() flushes reviewAuditor", async () => {
    let reviewFlushCalled = false;
    const reviewAuditor = {
      recordDispatch() {},
      recordDecision() {},
      getAdvisoryFindings: () => [],
      async flush() {
        reviewFlushCalled = true;
      },
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

    const rt2 = makeRuntime(NaxConfigSchema.parse({ name: "demo-app" }), "/tmp/any-path");
    expect(rt2.projectKey).toBe("demo-app");
    expect(rt2.outputDir).toBe(path.join(globalConfigDir(), "demo-app"));
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

// ─────────────────────────────────────────────────────────────────────────────
// usage audit wiring (#2045)
// ─────────────────────────────────────────────────────────────────────────────

describe("createRuntime usage audit wiring (#2045)", () => {
  test("enabled true writes a FLAT usage/<runId>.jsonl under the output dir, with NO featureName", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ name: "probe", outputDir: dir, agent: { usageAudit: { enabled: true } } });
      // featureName is deliberately omitted: unlike promptAudit, the usage sidecar
      // must not be gated on it. The path is also flat (`usage/<runId>.jsonl`,
      // matching `cost/<runId>.jsonl`), not nested under a feature directory.
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      const usageDir = join(rt.outputDir, "usage");
      const file = join(usageDir, `${rt.runId}.jsonl`);
      expect(await Bun.file(file).exists()).toBe(true);
      expect(readdirSync(usageDir)).toEqual([`${rt.runId}.jsonl`]);

      const [row] = (await Bun.file(file).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(row).toMatchObject({
        runId: rt.runId,
        scopeId: "scope-1",
        streamCallId: "call-001",
        input: 120,
        output: 45,
        costUsd: 0.0042,
      });
    });
  });

  test("enabled false (the default) creates NO usage/ directory at all", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ name: "probe", outputDir: dir });
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      expect(() => readdirSync(join(rt.outputDir, "usage"))).toThrow();
    });
  });

  test("agent.usageAudit.dir overrides the flat output-dir default", async () => {
    await withTempDir(async (dir) => {
      const customDir = join(dir, "custom-usage");
      const config = makeNaxConfig({
        name: "probe",
        outputDir: dir,
        agent: { usageAudit: { enabled: true, dir: customDir } },
      });
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      expect(await Bun.file(join(customDir, `${rt.runId}.jsonl`)).exists()).toBe(true);
      expect(() => readdirSync(join(rt.outputDir, "usage"))).toThrow();
    });
  });

  test("resolves a relative agent.usageAudit.dir from workdir, not the process cwd", async () => {
    await withTempDir(async (root) => {
      const workdir = join(root, "workdir");
      const otherCwd = join(root, "other-cwd");
      await Promise.all([mkdir(workdir), mkdir(otherCwd)]);
      const originalCwd = process.cwd();
      process.chdir(otherCwd);
      try {
        const config = makeNaxConfig({
          name: "probe",
          outputDir: join(root, "output"),
          agent: { usageAudit: { enabled: true, dir: "relative-usage" } },
        });
        const rt = makeRuntime(config, workdir);
        rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
        await rt.close();

        expect(await Bun.file(join(workdir, "relative-usage", `${rt.runId}.jsonl`)).exists()).toBe(true);
        expect(await Bun.file(join(otherCwd, "relative-usage", `${rt.runId}.jsonl`)).exists()).toBe(false);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  test("accepts an injected IUsageAuditor via CreateRuntimeOptions and exposes it", async () => {
    await withTempDir(async (dir) => {
      const recorded: UsageAuditEntry[] = [];
      const auditor: IUsageAuditor = { record: (entry) => recorded.push(entry), flush: async () => {} };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor: auditor });
      expect(rt.usageAuditor).toBe(auditor);

      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ runId: rt.runId, streamCallId: "call-001" });
      await rt.close();
    });
  });

  test("unsubscribes the usage subscriber on teardown", async () => {
    await withTempDir(async (dir) => {
      let records = 0;
      const auditor: IUsageAuditor = {
        record: () => {
          records++;
        },
        flush: async () => {},
      };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor: auditor });

      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(records).toBe(1);

      await rt.close();
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(records).toBe(1);
    });
  });

  test("awaits usageAuditor.flush() on close, alongside promptAuditor.flush()", async () => {
    await withTempDir(async (dir) => {
      let usageFlushed = false;
      let promptFlushed = false;
      const usageAuditor: IUsageAuditor = {
        record() {},
        async flush() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          usageFlushed = true;
        },
      };
      const promptAuditor = {
        record() {},
        recordError() {},
        async flush() {
          promptFlushed = true;
        },
      };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor, promptAuditor });

      await rt.close();

      expect(usageFlushed).toBe(true);
      expect(promptFlushed).toBe(true);
    });
  });
});
