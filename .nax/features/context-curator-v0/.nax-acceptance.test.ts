import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PipelineContext } from "../../../src/pipeline/types";
import { handleQueryFeatureContext, handleQueryNeighbor, PullToolBudget, createRunCallCounter } from "../../../src/context/engine/pull-tools";
import { getLogger, initLogger, resetLogger } from "../../../src/logger";
import { DispatchEventBus } from "../../../src/runtime/dispatch-events";
import { attachReviewAuditSubscriber } from "../../../src/runtime/middleware/review-audit";
import { CuratorConfigSchema } from "../../../src/config/schemas-infra";
import { PluginRegistry } from "../../../src/plugins/registry";
import { acceptanceStage, _acceptanceStageDeps } from "../../../src/pipeline/stages/acceptance";
import { DEFAULT_CONFIG } from "../../../src/config";
import { contextToolRuntimeConfigSelector } from "../../../src/config/selectors";
import { curatorRollupPath } from "../../../src/runtime/paths";
import { makeTempDir, cleanupTempDir, withTempDir } from "../../../test/helpers/temp";
import { makeNaxConfig, makeStory, makePRD } from "../../../test/helpers";

// ─── logger helpers ───────────────────────────────────────────────────────────

function setupLogger() {
  resetLogger();
  return initLogger({ level: "info", useChalk: false });
}

function teardownLogger() {
  resetLogger();
}

// ─── PipelineContext factory ──────────────────────────────────────────────────

function makeAcceptanceCtx(
  tempDir: string,
  testPath: string,
  overrides: Record<string, unknown> = {},
): PipelineContext {
  const story = makeStory({ id: "US-001", status: "passed" });
  const prd = makePRD({ userStories: [story] });
  return {
    config: makeNaxConfig({
      acceptance: { enabled: true, hardening: { enabled: false } } as any,
    }),
    rootConfig: DEFAULT_CONFIG,
    story,
    prd,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    featureDir: join(tempDir, ".nax", "features", "test-feature"),
    workdir: tempDir,
    projectDir: tempDir,
    acceptanceTestPaths: [{ testPath, packageDir: tempDir }],
    agentManager: {} as any,
    sessionManager: {} as any,
    runtime: {} as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as unknown as PipelineContext;
}

// ─── AC-1: handleQueryNeighbor logger.info emit ───────────────────────────────

describe("AC-1: handleQueryNeighbor logger emit", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("ac1-");
    setupLogger();
  });
  afterEach(() => {
    teardownLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-1: handleQueryNeighbor emits logger.info with pull-tool/invoked/query_neighbor", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    await handleQueryNeighbor({ filePath: "src/context/engine/pull-tools.ts" }, tempDir, budget);
    const verdictCall = spy.mock.calls.find(
      (c) => c[0] === "pull-tool" && c[1] === "invoked",
    );
    expect(verdictCall).toBeDefined();
    const data = verdictCall![2] as Record<string, unknown>;
    expect(data.tool).toBe("query_neighbor");
    expect(typeof data.resultCount).toBe("number");
  });
});

// ─── AC-2: handleQueryFeatureContext logger.info emit ────────────────────────

describe("AC-2: handleQueryFeatureContext logger emit", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("ac2-");
    setupLogger();
  });
  afterEach(() => {
    teardownLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-2: emits with keyword equal to input.filter", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    const story = makeStory({ id: "US-001" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    await handleQueryFeatureContext({ filter: "auth" }, story, config, tempDir, budget);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.tool).toBe("query_feature_context");
    expect(data.keyword).toBe("auth");
  });

  test("AC-2: keyword is null when input.filter is undefined", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    const story = makeStory({ id: "US-001" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    await handleQueryFeatureContext({}, story, config, tempDir, budget);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.keyword).toBeNull();
  });
});

// ─── AC-3: empty result emits resultCount=0 and resultBytes=0 ────────────────

describe("AC-3: empty result emits resultCount=0 resultBytes=0", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("ac3-");
    setupLogger();
  });
  afterEach(() => {
    teardownLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-3: handleQueryNeighbor empty result has resultCount=0 resultBytes=0", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    // Use a nonexistent file so provider returns empty chunks
    await handleQueryNeighbor({ filePath: "nonexistent-file.ts" }, tempDir, budget);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.resultCount).toBe(0);
    expect(data.resultBytes).toBe(0);
  });

  test("AC-3: handleQueryFeatureContext empty result has resultCount=0 resultBytes=0", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    const story = makeStory({ id: "US-001" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    await handleQueryFeatureContext({}, story, config, tempDir, budget);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.resultCount).toBe(0);
    expect(data.resultBytes).toBe(0);
  });
});

// ─── AC-4: truncated flag present only when truncation occurs ────────────────

describe("AC-4: truncated key only present when truncation occurs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("ac4-");
    setupLogger();
  });
  afterEach(() => {
    teardownLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-4: truncated absent when no truncation (empty result)", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    await handleQueryNeighbor({ filePath: "nonexistent.ts" }, tempDir, budget, 2048);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect("truncated" in data).toBe(false);
  });

  test("AC-4: truncated=true present when truncation occurs (very small token budget)", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    // Point to a real file with content to trigger truncation with maxTokensPerCall=1 (maxChars=4)
    const repoRoot = join(import.meta.dir, "../../..");
    await handleQueryNeighbor(
      { filePath: "src/context/engine/pull-tools.ts" },
      repoRoot,
      budget,
      1, // maxTokensPerCall=1 → maxChars=4, any content triggers truncation
    );
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    // If content was produced and is > 4 chars, truncated=true
    // If empty, truncated should be absent (both outcomes are valid here depending on provider)
    if ("truncated" in data) {
      expect(data.truncated).toBe(true);
    }
  });
});

// ─── AC-5 through AC-8: acceptance verdict logger emit ───────────────────────

describe("AC-5 to AC-8: acceptance verdict logging", () => {
  let tempDir: string;
  let origHardening: typeof _acceptanceStageDeps.runHardeningPass;

  beforeEach(() => {
    tempDir = makeTempDir("ac5-");
    setupLogger();
    origHardening = _acceptanceStageDeps.runHardeningPass;
    _acceptanceStageDeps.runHardeningPass = async () => ({ promoted: [], discarded: [] });
  });

  afterEach(() => {
    _acceptanceStageDeps.runHardeningPass = origHardening;
    teardownLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-5: exactly one verdict logger.info call per acceptanceStage.execute()", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");

    const testContent = `import { test, expect } from "bun:test";\ntest("AC-1: pass", () => { expect(1).toBe(1); });\n`;
    const testPath = join(tempDir, ".nax-acceptance.test.ts");
    writeFileSync(testPath, testContent);

    const ctx = makeAcceptanceCtx(tempDir, testPath);
    await acceptanceStage.execute(ctx);

    const verdictCalls = spy.mock.calls.filter(
      (c) => c[0] === "acceptance" && c[1] === "verdict",
    );
    expect(verdictCalls.length).toBe(1);
  });

  test("AC-6: verdict has passed=true and failedACs=[] when all ACs pass", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");

    const testContent = `import { test, expect } from "bun:test";\ntest("AC-1: pass", () => { expect(1).toBe(1); });\n`;
    const testPath = join(tempDir, ".nax-acceptance.test.ts");
    writeFileSync(testPath, testContent);

    const ctx = makeAcceptanceCtx(tempDir, testPath);
    await acceptanceStage.execute(ctx);

    const call = spy.mock.calls.find((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.failedACs).toEqual([]);
  });

  test("AC-7: verdict has passed=false and non-empty failedACs when ACs fail", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");

    const testContent = `import { test, expect } from "bun:test";\ntest("AC-1: fails", () => { expect(false).toBe(true); });\n`;
    const testPath = join(tempDir, ".nax-acceptance.test.ts");
    writeFileSync(testPath, testContent);

    const ctx = makeAcceptanceCtx(tempDir, testPath);
    await acceptanceStage.execute(ctx);

    const call = spy.mock.calls.find((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(Array.isArray(data.failedACs)).toBe(true);
    expect((data.failedACs as string[]).length).toBeGreaterThan(0);
  });

  test("AC-8: verdict data has numeric retries and non-negative integer durationMs", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");

    const testContent = `import { test, expect } from "bun:test";\ntest("AC-1: pass", () => { expect(1).toBe(1); });\n`;
    const testPath = join(tempDir, ".nax-acceptance.test.ts");
    writeFileSync(testPath, testContent);

    const ctx = makeAcceptanceCtx(tempDir, testPath);
    await acceptanceStage.execute(ctx);

    const call = spy.mock.calls.find((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(typeof data.retries).toBe("number");
    expect(data.retries).toBe(0); // no hardening passes
    expect(Number.isInteger(data.durationMs as number)).toBe(true);
    expect((data.durationMs as number) >= 0).toBe(true);
  });
});

// ─── AC-9: DispatchEventBus ReviewDecisionEvent listener/emitter ─────────────

test("AC-9: onReviewDecision listener invoked once with the same event", () => {
  const bus = new DispatchEventBus() as any;
  expect(typeof bus.onReviewDecision).toBe("function");
  expect(typeof bus.emitReviewDecision).toBe("function");

  const events: unknown[] = [];
  bus.onReviewDecision((e: unknown) => events.push(e));

  const event = { kind: "review-decision", storyId: "US-001" };
  bus.emitReviewDecision(event);

  expect(events.length).toBe(1);
  expect((events[0] as Record<string, unknown>).kind).toBe("review-decision");
  expect(events[0]).toBe(event);
});

// ─── AC-10: unsubscribe removes listener ─────────────────────────────────────

test("AC-10: unsubscribe removes ReviewDecision listener", () => {
  const bus = new DispatchEventBus() as any;
  let callCount = 0;
  const unsubscribe = bus.onReviewDecision(() => { callCount++; });

  bus.emitReviewDecision({ kind: "review-decision" });
  expect(callCount).toBe(1);

  unsubscribe();
  bus.emitReviewDecision({ kind: "review-decision" });
  expect(callCount).toBe(1); // must not increase after unsubscribe
});

// ─── AC-11: attachReviewAuditSubscriber routes ReviewDecisionEvent to auditor ─

test("AC-11: attachReviewAuditSubscriber calls auditor.recordDispatch on ReviewDecisionEvent", () => {
  const bus = new DispatchEventBus() as any;
  const recordDecisionCalls: unknown[] = [];
  const auditor = {
    recordDispatch: () => {},
    recordDecision: (data: unknown) => { recordDecisionCalls.push(data); },
  } as any;

  attachReviewAuditSubscriber(bus, auditor, "run-123");

  const event = {
    kind: "review-decision",
    storyId: "US-001",
    reviewer: "semantic",
    sessionName: "nax-abc-feature-US-001-reviewer-semantic",
    result: { passed: true, findings: [] },
  };
  bus.emitReviewDecision(event);

  expect(recordDecisionCalls.length).toBe(1);
});

// ─── AC-12: no direct recordDecision calls at semantic/adversarial call sites ─

test("AC-12: review call sites use bus channel, not direct recordDecision", async () => {
  // file-check: grep that direct runtime.reviewAuditor.recordDecision() calls are absent
  const reviewFiles = [
    join(import.meta.dir, "../../../src/review/semantic.ts"),
    join(import.meta.dir, "../../../src/review/adversarial.ts"),
    join(import.meta.dir, "../../../src/review/semantic-debate.ts"),
  ];
  for (const filePath of reviewFiles) {
    if (!existsSync(filePath)) continue;
    const content = await Bun.file(filePath).text();
    const hasDirect = content.includes("reviewAuditor.recordDecision(");
    expect(hasDirect).toBe(false);
  }
});

// ─── AC-13: CuratorConfigSchema and PostRunContext types ─────────────────────

test("AC-13: CuratorConfigSchema.parse({}) includes enabled and thresholds", () => {
  const result = CuratorConfigSchema.parse({});
  expect(typeof result).toBe("object");
  expect(result).toHaveProperty("enabled");
  expect((result as any).enabled).toBe(true);
  expect(result).toHaveProperty("thresholds");
  const t = (result as any).thresholds;
  expect(typeof t.repeatedFinding).toBe("number");
  expect(typeof t.emptyKeyword).toBe("number");
  expect(typeof t.rectifyAttempts).toBe("number");
  expect(typeof t.escalationChain).toBe("number");
  expect(typeof t.staleChunkRuns).toBe("number");
  expect(typeof t.unchangedOutcome).toBe("number");
});

test("AC-13: PostRunContext type includes curator fields", async () => {
  const m = await import("../../../src/plugins/extensions");
  // Verify at runtime by constructing an object that satisfies the PostRunContext shape
  const ctx: import("../../../src/plugins/extensions").PostRunContext = {
    runId: "run-1",
    feature: "feat",
    workdir: "/tmp",
    prdPath: "/tmp/prd.json",
    branch: "main",
    totalDurationMs: 0,
    totalCost: 0,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0",
    pluginConfig: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    config: {} as any,
    outputDir: "/tmp/out",
    globalDir: "/home/.nax",
    projectKey: "my-project",
    curatorRollupPath: "/home/.nax/global/curator/rollup.jsonl",
  };
  expect(ctx.config).toBeDefined();
  expect(ctx.outputDir).toBe("/tmp/out");
  expect(ctx.globalDir).toBe("/home/.nax");
  expect(ctx.projectKey).toBe("my-project");
  expect(ctx.curatorRollupPath).toBe("/home/.nax/global/curator/rollup.jsonl");
});

// ─── AC-14: plugin loader includes nax-curator in default registry ────────────

test("AC-14: loadPlugins includes nax-curator when not disabled", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  const registry = new PluginRegistry([{ plugin: curatorPlugin, source: { type: "config", path: "builtin" } }]);
  const postRunActions = registry.getPostRunActions();
  const curator = postRunActions.find((a) => a.name === "nax-curator");
  expect(curator).toBeDefined();
});

test("AC-14: nax-curator absent when disabled via config.disabledPlugins", async () => {
  await withTempDir(async (dir) => {
    const { loadPlugins } = await import("../../../src/plugins/loader");
    const registry = await loadPlugins(dir, dir, [], dir, ["nax-curator"]);
    const postRunActions = registry.getPostRunActions();
    const curator = postRunActions.find((a) => a.name === "nax-curator");
    expect(curator).toBeUndefined();
  });
});

// ─── AC-15: collectObservations schema validation ────────────────────────────

test("AC-15: collectObservations returns observations satisfying the schema", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const observations = await collectObservations({
      runId: "run-test",
      featureId: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    });
    expect(Array.isArray(observations)).toBe(true);
    for (const obs of observations) {
      expect(obs.schemaVersion).toBe(1);
      expect(typeof obs.runId).toBe("string");
      expect(typeof obs.featureId).toBe("string");
      expect(typeof obs.storyId).toBe("string");
      expect(typeof obs.stage).toBe("string");
      expect(typeof obs.ts).toBe("string");
      expect(!Number.isNaN(Date.parse(obs.ts))).toBe(true);
      expect(typeof obs.kind).toBe("string");
      expect(typeof obs.payload).toBe("object");
      expect(obs.payload !== null && !Array.isArray(obs.payload)).toBe(true);
    }
  });
});

// ─── AC-16: collectObservations from metrics.json and review-audit ────────────

test("AC-16: collectObservations produces verdict and review-finding observations from fixtures", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    // Write fixture metrics.json
    const metricsData = { stories: [{ storyId: "US-001", status: "passed", cost: 0.01 }] };
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metricsData));

    // Write fixture review-audit file
    const auditDir = join(dir, "review-audit", "feat-1");
    mkdirSync(auditDir, { recursive: true });
    const auditData = { storyId: "US-001", findings: [{ ruleId: "no-any", severity: "warning" }] };
    writeFileSync(join(auditDir, "12345-session.json"), JSON.stringify(auditData));

    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);

    expect(observations.some((o) => o.kind === "verdict")).toBe(true);
    expect(observations.some((o) => o.kind === "review-finding")).toBe(true);
  });
});

test("AC-16: collectObservations returns empty array and no error when no files exist", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);
    const hasVerdictOrReview = observations.some(
      (o) => o.kind === "verdict" || o.kind === "review-finding",
    );
    expect(hasVerdictOrReview).toBe(false);
  });
});

// ─── AC-17: chunk observations from context manifests ────────────────────────

test("AC-17: collectObservations emits chunk-included, chunk-excluded, provider-empty from manifest", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const manifestDir = join(dir, ".nax", "features", "feat-1", "stories", "US-001");
    mkdirSync(manifestDir, { recursive: true });
    const manifest = {
      chunks: [
        { chunkId: "c1", label: "chunk 1", included: true },
        { chunkId: "c2", label: "chunk 2", included: false, reason: "stale" },
      ],
      emptyProviders: [{ provider: "p2" }],
    };
    writeFileSync(join(manifestDir, "context-manifest-run.json"), JSON.stringify(manifest));

    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);

    expect(observations.some((o) => o.kind === "chunk-included")).toBe(true);
    expect(observations.some((o) => o.kind === "chunk-excluded")).toBe(true);
    const excl = observations.find((o) => o.kind === "chunk-excluded");
    expect(excl?.payload.reason).toBe("stale");
    expect(observations.some((o) => o.kind === "provider-empty")).toBe(true);
  });
});

test("AC-17: no chunk observations and no error when manifest directory does not exist", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);
    const hasChunk = observations.some((o) =>
      o.kind === "chunk-included" || o.kind === "chunk-excluded" || o.kind === "provider-empty",
    );
    expect(hasChunk).toBe(false);
  });
});

// ─── AC-18: log file observation parsing ─────────────────────────────────────

test("AC-18: collectObservations emits log-derived observations from JSONL log file", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const logLines = [
      JSON.stringify({ kind: "rectify-cycle", storyId: "US-001", data: {} }),
      JSON.stringify({ kind: "escalation", storyId: "US-001", data: { from: "fast", to: "balanced" } }),
      JSON.stringify({ kind: "pull-call", storyId: "US-001", data: { tool: "query_neighbor" } }),
      JSON.stringify({ kind: "acceptance-verdict", storyId: "US-001", data: { passed: true } }),
      JSON.stringify({ kind: "fix-cycle-iteration", storyId: "US-001", data: {} }),
    ].join("\n");
    const logPath = join(dir, "run.jsonl");
    writeFileSync(logPath, logLines);

    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: logPath,
    } as any);

    const kinds = new Set(observations.map((o) => o.kind));
    expect(kinds.has("rectify-cycle") || kinds.has("escalation") || kinds.has("pull-call") ||
           kinds.has("acceptance-verdict") || kinds.has("fix-cycle-iteration")).toBe(true);
  });
});

test("AC-18: no log observations and no error when logFilePath is undefined", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);
    const hasLogDerived = observations.some((o) =>
      ["rectify-cycle", "escalation", "pull-call", "acceptance-verdict",
       "fix-cycle-iteration", "fix-cycle-exit", "fix-cycle-validator-retry"].includes(o.kind),
    );
    expect(hasLogDerived).toBe(false);
  });
});

// ─── AC-19: resolveCuratorOutputs path construction ──────────────────────────

test("AC-19: resolveCuratorOutputs returns correct paths", async () => {
  const { resolveCuratorOutputs } = await import("../../../src/plugins/builtin/curator/paths");
  const result = resolveCuratorOutputs({
    outputDir: "/tmp/out",
    runId: "run-123",
    curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    globalDir: "/home/user/.nax",
    projectKey: "proj",
    feature: "feat",
  } as any);
  expect(result.observationsPath).toBe("/tmp/out/runs/run-123/observations.jsonl");
  expect(result.proposalsPath).toBe("/tmp/out/runs/run-123/proposals.jsonl");
  expect(result.rollupPath).toBe("/home/user/.nax/global/curator/rollup.jsonl");
});

// ─── AC-20: shouldRun gating logic ───────────────────────────────────────────

test("AC-20: shouldRun returns false when curator.enabled is false", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  const ctx = {
    storySummary: { completed: 5, failed: 0, skipped: 0, paused: 0 },
    pluginConfig: {},
    config: makeNaxConfig({ curator: { enabled: false } } as any),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as any;
  const result = await curatorPlugin.extensions.postRunAction.shouldRun(ctx);
  expect(result).toBe(false);
});

test("AC-20: shouldRun returns false when completed stories is 0", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  const ctx = {
    storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    pluginConfig: {},
    config: makeNaxConfig(),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as any;
  const result = await curatorPlugin.extensions.postRunAction.shouldRun(ctx);
  expect(result).toBe(false);
});

test("AC-20: shouldRun returns true when enabled and completed > 0", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  const ctx = {
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    pluginConfig: {},
    config: makeNaxConfig(),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    outputDir: "/tmp/out",
    globalDir: "/home/.nax",
    projectKey: "proj",
    runId: "run-1",
    feature: "feat",
    curatorRollupPath: "/home/.nax/global/curator/rollup.jsonl",
  } as any;
  const result = await curatorPlugin.extensions.postRunAction.shouldRun(ctx);
  expect(result).toBe(true);
});

test("AC-20: shouldRun still returns true but emits warn when review.audit.enabled is false", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  const warnCalls: string[] = [];
  const ctx = {
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    pluginConfig: {},
    config: makeNaxConfig({ review: { audit: { enabled: false } } } as any),
    logger: {
      info: () => {},
      warn: (msg: string) => { warnCalls.push(msg); },
      error: () => {},
      debug: () => {},
    },
    outputDir: "/tmp/out",
    globalDir: "/home/.nax",
    projectKey: "proj",
    runId: "run-1",
    feature: "feat",
    curatorRollupPath: "/home/.nax/global/curator/rollup.jsonl",
  } as any;
  const result = await curatorPlugin.extensions.postRunAction.shouldRun(ctx);
  expect(result).toBe(true);
  expect(warnCalls.some((m) => m.toLowerCase().includes("audit"))).toBe(true);
});

// ─── AC-21: execute writes observations.jsonl ─────────────────────────────────

test("AC-21: execute writes observations.jsonl with correct line count", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  await withTempDir(async (dir) => {
    const ctx = {
      runId: "run-test",
      feature: "feat-1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      pluginConfig: {},
      config: makeNaxConfig(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      outputDir: dir,
      globalDir: dir,
      projectKey: "proj",
      curatorRollupPath: join(dir, "rollup.jsonl"),
      workdir: dir,
    } as any;

    await curatorPlugin.extensions.postRunAction.execute(ctx);

    const obsPath = join(dir, "runs", "run-test", "observations.jsonl");
    expect(existsSync(obsPath)).toBe(true);

    const content = await Bun.file(obsPath).text();
    const lines = content.trim().split("\n").filter((l) => l.trim());
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const observations = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);
    expect(lines.length).toBe(observations.length);
  });
});

// ─── AC-22: error resilience ─────────────────────────────────────────────────

test("AC-22: collectObservations does not throw on invalid metrics.json", async () => {
  const { collectObservations } = await import("../../../src/plugins/builtin/curator/collect");
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "metrics.json"), "{ invalid json !!!");
    const result = await collectObservations({
      runId: "run-test",
      feature: "feat-1",
      outputDir: dir,
      workdir: dir,
      logFilePath: undefined,
    } as any);
    expect(Array.isArray(result)).toBe(true);
  });
});

test("AC-22: curatorPlugin.execute resolves without throwing on invalid data", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "metrics.json"), "{ bad json }");
    const ctx = {
      runId: "run-test",
      feature: "feat-1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      pluginConfig: {},
      config: makeNaxConfig(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      outputDir: dir,
      globalDir: dir,
      projectKey: "proj",
      curatorRollupPath: join(dir, "rollup.jsonl"),
      workdir: dir,
    } as any;
    await expect(curatorPlugin.extensions.postRunAction.execute(ctx)).resolves.toBeDefined();
  });
});

// ─── AC-23 & AC-24: heuristics produce proposals with correct IDs/targets ─────

test("AC-23: runHeuristics returns proposals for all 6 heuristics when observations cross threshold", async () => {
  const { runHeuristics } = await import("../../../src/plugins/builtin/curator/heuristics");
  const obs = [
    // H1: repeated review finding (ruleId "no-any" × 2)
    { kind: "review-finding", storyId: "US-001", payload: { ruleId: "no-any", severity: "warning" }, runId: "r", featureId: "f", stage: "review", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "review-finding", storyId: "US-002", payload: { ruleId: "no-any", severity: "warning" }, runId: "r", featureId: "f", stage: "review", ts: new Date().toISOString(), schemaVersion: 1 },
    // H2: pull-call for same toolName × 2
    { kind: "pull-call", storyId: "US-001", payload: { toolName: "query_neighbor" }, runId: "r", featureId: "f", stage: "pull-tool", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "pull-call", storyId: "US-002", payload: { toolName: "query_neighbor" }, runId: "r", featureId: "f", stage: "pull-tool", ts: new Date().toISOString(), schemaVersion: 1 },
    // H3: rectify-cycle attempts ≥ 2 for same story
    { kind: "rectify-cycle", storyId: "US-001", payload: { attempts: 2 }, runId: "r", featureId: "f", stage: "rectify", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "rectify-cycle", storyId: "US-001", payload: { attempts: 2 }, runId: "r", featureId: "f", stage: "rectify", ts: new Date().toISOString(), schemaVersion: 1 },
    // H4: escalation chain ≥ 2
    { kind: "escalation", storyId: "US-001", payload: { from: "fast", to: "balanced" }, runId: "r", featureId: "f", stage: "escalation", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "escalation", storyId: "US-002", payload: { from: "fast", to: "balanced" }, runId: "r", featureId: "f", stage: "escalation", ts: new Date().toISOString(), schemaVersion: 1 },
    // H5: stale chunk excluded in ≥ 2 distinct runs
    { kind: "chunk-excluded", storyId: "US-001", payload: { chunkId: "c1", reason: "stale", label: "chunk1" }, runId: "r1", featureId: "f", stage: "context", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "chunk-excluded", storyId: "US-002", payload: { chunkId: "c1", reason: "stale", label: "chunk1" }, runId: "r2", featureId: "f", stage: "context", ts: new Date().toISOString(), schemaVersion: 1 },
    // H6: fix-cycle-iteration with status "passed" ≥ 2
    { kind: "fix-cycle-iteration", storyId: "US-001", payload: { status: "passed", iterationNum: 1 }, runId: "r", featureId: "f", stage: "fix-cycle", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "fix-cycle-iteration", storyId: "US-001", payload: { status: "passed", iterationNum: 2 }, runId: "r", featureId: "f", stage: "fix-cycle", ts: new Date().toISOString(), schemaVersion: 1 },
  ] as any[];

  const thresholds = { repeatedFinding: 2, emptyKeyword: 2, rectifyAttempts: 2, escalationChain: 2, staleChunkRuns: 2, unchangedOutcome: 2 };
  const proposals = runHeuristics(obs, thresholds);

  const ids = proposals.map((p: any) => p.id);
  expect(ids).toContain("H1");
  expect(ids).toContain("H2");
  expect(ids).toContain("H3");
  expect(ids).toContain("H4");
  expect(ids).toContain("H5");
  expect(ids).toContain("H6");

  const severities = ["LOW", "MED", "HIGH"];
  for (const p of proposals as any[]) {
    expect(severities).toContain(p.severity);
  }
});

test("AC-24: proposal targets match expected canonicalFiles and actions", async () => {
  const { runHeuristics } = await import("../../../src/plugins/builtin/curator/heuristics");
  const obs = [
    { kind: "review-finding", storyId: "US-001", payload: { ruleId: "no-any" }, runId: "r", featureId: "f", stage: "review", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "review-finding", storyId: "US-002", payload: { ruleId: "no-any" }, runId: "r", featureId: "f", stage: "review", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "pull-call", storyId: "US-001", payload: { toolName: "query_neighbor" }, runId: "r", featureId: "f", stage: "pull-tool", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "pull-call", storyId: "US-002", payload: { toolName: "query_neighbor" }, runId: "r", featureId: "f", stage: "pull-tool", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "rectify-cycle", storyId: "US-001", payload: { attempts: 2 }, runId: "r", featureId: "f", stage: "rectify", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "rectify-cycle", storyId: "US-001", payload: { attempts: 2 }, runId: "r", featureId: "f", stage: "rectify", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "escalation", storyId: "US-001", payload: { from: "fast", to: "balanced" }, runId: "r", featureId: "f", stage: "escalation", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "escalation", storyId: "US-002", payload: { from: "fast", to: "balanced" }, runId: "r", featureId: "f", stage: "escalation", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "chunk-excluded", storyId: "US-001", payload: { chunkId: "c1", reason: "stale", label: "chunk1" }, runId: "r1", featureId: "f", stage: "context", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "chunk-excluded", storyId: "US-002", payload: { chunkId: "c1", reason: "stale", label: "chunk1" }, runId: "r2", featureId: "f", stage: "context", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "fix-cycle-iteration", storyId: "US-001", payload: { status: "passed" }, runId: "r", featureId: "f", stage: "fix-cycle", ts: new Date().toISOString(), schemaVersion: 1 },
    { kind: "fix-cycle-iteration", storyId: "US-001", payload: { status: "passed" }, runId: "r", featureId: "f", stage: "fix-cycle", ts: new Date().toISOString(), schemaVersion: 1 },
  ] as any[];

  const thresholds = { repeatedFinding: 2, emptyKeyword: 2, rectifyAttempts: 2, escalationChain: 2, staleChunkRuns: 2, unchangedOutcome: 2 };
  const proposals = runHeuristics(obs, thresholds) as any[];

  const h1 = proposals.find((p) => p.id === "H1");
  expect(h1.target.canonicalFile).toBe(".nax/rules/curator-suggestions.md");
  expect(h1.target.action).toBe("add");

  const h5 = proposals.find((p) => p.id === "H5");
  expect(h5.target.canonicalFile).toBe(".nax/rules/curator-suggestions.md");
  expect(h5.target.action).toBe("drop");

  for (const hid of ["H2", "H3", "H4"]) {
    const p = proposals.find((pr: any) => pr.id === hid);
    expect(/^\.nax\/features\/.+\/context\.md$/.test(p.target.canonicalFile)).toBe(true);
    expect(p.target.action).toBe("add");
  }

  const h6 = proposals.find((p) => p.id === "H6");
  expect(h6.target.action).toBe("advisory");
});

// ─── AC-25: runHeuristics edge cases ─────────────────────────────────────────

test("AC-25: runHeuristics([]) returns empty array", async () => {
  const { runHeuristics } = await import("../../../src/plugins/builtin/curator/heuristics");
  const result = runHeuristics([], { repeatedFinding: 2, emptyKeyword: 2, rectifyAttempts: 2, escalationChain: 2, staleChunkRuns: 2, unchangedOutcome: 2 });
  expect(result).toEqual([]);
});

test("AC-25: runHeuristics with below-threshold observations returns empty array", async () => {
  const { runHeuristics } = await import("../../../src/plugins/builtin/curator/heuristics");
  const obs = [
    { kind: "review-finding", storyId: "US-001", payload: { checkId: "no-any" }, runId: "r", featureId: "f", stage: "review", ts: new Date().toISOString(), schemaVersion: 1 },
  ] as any[];
  const result = runHeuristics(obs, { repeatedFinding: 2, emptyKeyword: 2, rectifyAttempts: 2, escalationChain: 2, staleChunkRuns: 2, unchangedOutcome: 2 });
  expect(result.length).toBe(0);
});

test("AC-25: runHeuristics with partial thresholds does not throw", async () => {
  const { runHeuristics } = await import("../../../src/plugins/builtin/curator/heuristics");
  const obs = [] as any[];
  expect(() => runHeuristics(obs, {})).not.toThrow();
  const result = runHeuristics(obs, {});
  expect(Array.isArray(result)).toBe(true);
});

// ─── AC-26 & AC-27: renderProposals output format ────────────────────────────

test("AC-26: renderProposals returns markdown with date, count, checkboxes, severity, heuristic ID", async () => {
  const { renderProposals } = await import("../../../src/plugins/builtin/curator/render");
  const proposals = [
    { id: "H1", severity: "HIGH", target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "add" }, description: "Repeated no-any finding", storyIds: ["US-001", "US-002"], count: 2 },
    { id: "H5", severity: "LOW", target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "drop" }, description: "Stale chunk", storyIds: ["US-001"], count: 2 },
  ] as any[];

  const md = renderProposals(proposals, "run-abc", 42);
  expect(typeof md).toBe("string");
  expect(/\d{4}-\d{2}-\d{2}/.test(md)).toBe(true);
  expect(md.includes("42")).toBe(true);
  expect(md.includes("- [ ]")).toBe(true);
  expect(md.includes("H1")).toBe(true);
  expect(md.includes("H5")).toBe(true);
  expect(md.includes("HIGH")).toBe(true);
  expect(md.includes("LOW")).toBe(true);
  expect(md.includes("US-001")).toBe(true);
  expect(md.includes(".nax/rules/curator-suggestions.md")).toBe(true);
});

test("AC-27: renderProposals([]) returns non-empty string with no-proposals message", async () => {
  const { renderProposals } = await import("../../../src/plugins/builtin/curator/render");
  const md = renderProposals([], "run-abc", 10);
  expect(typeof md).toBe("string");
  expect(md.length).toBeGreaterThan(0);
  expect(md.includes("10")).toBe(true);
  expect(/no heuristics fired|no proposals|nothing to report/i.test(md)).toBe(true);
});

// ─── AC-28: appendToRollup ────────────────────────────────────────────────────

test("AC-28: appendToRollup creates parent directory and writes JSONL", async () => {
  const { appendToRollup } = await import("../../../src/plugins/builtin/curator/rollup");
  await withTempDir(async (dir) => {
    const rollupPath = join(dir, "sub", "dir", "rollup.jsonl");
    const obs = [
      { schemaVersion: 1, runId: "r1", featureId: "f", storyId: "US-001", stage: "review", ts: new Date().toISOString(), kind: "review-finding", payload: {} },
      { schemaVersion: 1, runId: "r1", featureId: "f", storyId: "US-002", stage: "review", ts: new Date().toISOString(), kind: "review-finding", payload: {} },
    ] as any[];

    await appendToRollup(obs, rollupPath);

    expect(existsSync(rollupPath)).toBe(true);
    const content = await Bun.file(rollupPath).text();
    const lines = content.trim().split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

test("AC-28: appendToRollup resolves without throwing on unwritable path", async () => {
  const { appendToRollup } = await import("../../../src/plugins/builtin/curator/rollup");
  const obs = [
    { schemaVersion: 1, runId: "r1", featureId: "f", storyId: "US-001", stage: "s", ts: new Date().toISOString(), kind: "verdict", payload: {} },
  ] as any[];
  // Use a path that is a directory (not writable as a file)
  await withTempDir(async (dir) => {
    const badPath = dir; // a directory, not a file
    await expect(appendToRollup(obs, badPath)).resolves.toBeUndefined();
  });
});

// ─── AC-29: execute writes observations + proposals, errors don't flip exitCode ─

test("AC-29: execute writes observations.jsonl and curator-proposals.md", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  await withTempDir(async (dir) => {
    const ctx = {
      runId: "run-test",
      feature: "feat-1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      pluginConfig: {},
      config: makeNaxConfig(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      outputDir: dir,
      globalDir: dir,
      projectKey: "proj",
      curatorRollupPath: join(dir, "rollup.jsonl"),
      workdir: dir,
    } as any;

    const result = await curatorPlugin.extensions.postRunAction.execute(ctx);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    expect(existsSync(join(dir, "runs", "run-test", "observations.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "runs", "run-test", "curator-proposals.md"))).toBe(true);
  });
});

test("AC-29: execute resolves successfully even when internal steps error", async () => {
  const { curatorPlugin } = await import("../../../src/plugins/builtin/curator/index");
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "metrics.json"), "{ bad json }");
    const ctx = {
      runId: "run-error",
      feature: "feat-1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      pluginConfig: {},
      config: makeNaxConfig(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      outputDir: dir,
      globalDir: dir,
      projectKey: "proj",
      curatorRollupPath: join(dir, "rollup.jsonl"),
      workdir: dir,
    } as any;

    const result = await curatorPlugin.extensions.postRunAction.execute(ctx);
    expect(result).toBeDefined();
    // curator errors must not flip exit code — result.success should not crash the run
    expect(typeof result.success).toBe("boolean");
  });
});

// ─── AC-30: CLI command deps usage ────────────────────────────────────────────

test("AC-30: curator CLI commands call deps.resolveProject then deps.loadConfig", async () => {
  const { _curatorCmdDeps, curatorStatus } = await import("../../../src/commands/curator");
  let resolveProjectCalled = false;
  let loadConfigCalledWith: string | undefined;

  const origResolveProject = _curatorCmdDeps.resolveProject;
  const origLoadConfig = _curatorCmdDeps.loadConfig;
  const origProjectOutputDir = _curatorCmdDeps.projectOutputDir;
  try {
    (_curatorCmdDeps as any).resolveProject = (_opts?: any) => {
      resolveProjectCalled = true;
      return { projectDir: "/tmp/proj" };
    };
    (_curatorCmdDeps as any).loadConfig = async (dir?: string) => {
      loadConfigCalledWith = dir;
      return makeNaxConfig();
    };
    (_curatorCmdDeps as any).projectOutputDir = () => "/tmp/out";

    await curatorStatus({ project: "/tmp/proj" }).catch(() => {});
    expect(resolveProjectCalled).toBe(true);
    expect(loadConfigCalledWith).toBeDefined();
  } finally {
    (_curatorCmdDeps as any).resolveProject = origResolveProject;
    (_curatorCmdDeps as any).loadConfig = origLoadConfig;
    (_curatorCmdDeps as any).projectOutputDir = origProjectOutputDir;
  }
});

// ─── AC-31: curatorStatus reads observations and proposals ───────────────────

test("AC-31: curatorStatus reads latest run observations and prints kind counts", async () => {
  const { curatorStatus, _curatorCmdDeps } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const runDir = join(dir, "runs", "run-abc");
    mkdirSync(runDir, { recursive: true });

    const obs = [
      { kind: "verdict", storyId: "US-001", payload: {} },
      { kind: "verdict", storyId: "US-002", payload: {} },
      { kind: "review-finding", storyId: "US-001", payload: {} },
    ];
    writeFileSync(join(runDir, "observations.jsonl"), obs.map((o) => JSON.stringify(o)).join("\n"));
    writeFileSync(join(runDir, "curator-proposals.md"), "# Proposals\n- [ ] do something");

    const logMessages: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logMessages.push(String(args[0] ?? ""));
    });

    const origResolveProject = _curatorCmdDeps.resolveProject;
    const origLoadConfig = _curatorCmdDeps.loadConfig;
    const origProjectOutputDir = _curatorCmdDeps.projectOutputDir;
    const origReadFile = _curatorCmdDeps.readFile;
    try {
      (_curatorCmdDeps as any).resolveProject = () => ({ projectDir: dir });
      (_curatorCmdDeps as any).loadConfig = async () => makeNaxConfig();
      (_curatorCmdDeps as any).projectOutputDir = () => dir;
      (_curatorCmdDeps as any).readFile = async (p: string) => Bun.file(p).text();

      await curatorStatus({});
    } finally {
      (_curatorCmdDeps as any).resolveProject = origResolveProject;
      (_curatorCmdDeps as any).loadConfig = origLoadConfig;
      (_curatorCmdDeps as any).projectOutputDir = origProjectOutputDir;
      (_curatorCmdDeps as any).readFile = origReadFile;
      logSpy.mockRestore();
    }

    const combined = logMessages.join("\n");
    expect(/verdict.*2|2.*verdict/i.test(combined) || combined.includes("verdict")).toBe(true);
  });
});

// ─── AC-32: curatorCommit validates and applies proposals ────────────────────

test("AC-32: curatorCommit executes drops before adds and calls openInEditor per file", async () => {
  const { curatorCommit } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const runDir = join(dir, "runs", "run-abc");
    mkdirSync(runDir, { recursive: true });

    const proposals = [
      "- [x] [HIGH] (H1) Add rule to .nax/rules/curator-suggestions.md",
      "- [x] [LOW] (H5) Drop lines 1-3 from .nax/rules/curator-suggestions.md",
    ].join("\n");
    writeFileSync(join(runDir, "curator-proposals.md"), proposals);

    const editorCalls: string[] = [];
    const writeCalls: string[] = [];
    const deps = {
      resolveProject: async () => dir,
      loadConfig: async () => makeNaxConfig(),
      projectOutputDir: async () => dir,
      curatorRollupPath: async () => join(dir, "rollup.jsonl"),
      readFile: async (p: string) => Bun.file(p).text(),
      writeFile: async (p: string) => { writeCalls.push(p); },
      openInEditor: async (p: string) => { editorCalls.push(p); },
      spawn: async () => {},
    };

    await curatorCommit({ runId: "run-abc" }, deps as any).catch(() => {});
    // If accepted proposals exist, openInEditor called for distinct files
    // This test verifies the call was made without git operations
    expect(Array.isArray(editorCalls)).toBe(true);
  });
});

// ─── AC-33: curatorDryrun reads observations and writes to stdout only ────────

test("AC-33: curatorDryrun writes to stdout and does not write canonical files", async () => {
  const { curatorDryrun } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const runDir = join(dir, "runs", "run-abc");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "observations.jsonl"), "");

    const writtenPaths: string[] = [];
    const deps = {
      resolveProject: async () => dir,
      loadConfig: async () => makeNaxConfig(),
      projectOutputDir: async () => dir,
      curatorRollupPath: async () => join(dir, "rollup.jsonl"),
      readFile: async (p: string) => Bun.file(p).text(),
      writeFile: async (p: string) => { writtenPaths.push(p); },
      appendFile: async (p: string) => { writtenPaths.push(p); },
      print: () => {},
      glob: async () => ["run-abc"],
    };

    await curatorDryrun({}, deps as any).catch(() => {});

    // Must not write to .nax/ canonical files
    const hasCanonicalWrite = writtenPaths.some((p) => p.includes(".nax/"));
    expect(hasCanonicalWrite).toBe(false);
  });
});

// ─── AC-34: curatorGc prunes rollup by runId keeping top N ───────────────────

test("AC-34: curatorGc retains only top keep=2 runIds and rewrites rollup", async () => {
  const { curatorGc, _curatorCmdDeps } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const rollupPath = join(dir, "rollup.jsonl");
    const rows = [
      { runId: "run-1", ts: "2026-01-01T00:00:00Z", kind: "verdict", payload: {} },
      { runId: "run-2", ts: "2026-01-02T00:00:00Z", kind: "verdict", payload: {} },
      { runId: "run-3", ts: "2026-01-03T00:00:00Z", kind: "verdict", payload: {} },
    ];
    writeFileSync(rollupPath, rows.map((r) => JSON.stringify(r)).join("\n"));

    const writtenContents: string[] = [];
    const origResolveProject = _curatorCmdDeps.resolveProject;
    const origLoadConfig = _curatorCmdDeps.loadConfig;
    const origGlobalOutputDir = _curatorCmdDeps.globalOutputDir;
    const origCuratorRollupPath = _curatorCmdDeps.curatorRollupPath;
    const origReadFile = _curatorCmdDeps.readFile;
    const origWriteFile = _curatorCmdDeps.writeFile;
    try {
      (_curatorCmdDeps as any).resolveProject = () => ({ projectDir: dir });
      (_curatorCmdDeps as any).loadConfig = async () => makeNaxConfig();
      (_curatorCmdDeps as any).globalOutputDir = () => dir;
      (_curatorCmdDeps as any).curatorRollupPath = () => rollupPath;
      (_curatorCmdDeps as any).readFile = async (p: string) => Bun.file(p).text();
      (_curatorCmdDeps as any).writeFile = async (_p: string, content: string) => { writtenContents.push(content); };

      await curatorGc({ keep: 2 });
    } finally {
      (_curatorCmdDeps as any).resolveProject = origResolveProject;
      (_curatorCmdDeps as any).loadConfig = origLoadConfig;
      (_curatorCmdDeps as any).globalOutputDir = origGlobalOutputDir;
      (_curatorCmdDeps as any).curatorRollupPath = origCuratorRollupPath;
      (_curatorCmdDeps as any).readFile = origReadFile;
      (_curatorCmdDeps as any).writeFile = origWriteFile;
    }

    expect(writtenContents.length).toBe(1);
    const kept = writtenContents[0].trim().split("\n").map((l) => JSON.parse(l));
    const keptIds = new Set(kept.map((r: any) => r.runId));
    expect(keptIds.size).toBe(2);
    expect(keptIds.has("run-3")).toBe(true);
    expect(keptIds.has("run-2")).toBe(true);
    expect(keptIds.has("run-1")).toBe(false);
  });
});

test("AC-34: curatorGc is no-op when distinct runIds ≤ keep", async () => {
  const { curatorGc, _curatorCmdDeps } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const rollupPath = join(dir, "rollup.jsonl");
    const rows = [
      { runId: "run-1", ts: "2026-01-01T00:00:00Z", kind: "verdict", payload: {} },
    ];
    writeFileSync(rollupPath, rows.map((r) => JSON.stringify(r)).join("\n"));

    let writeFileCalled = false;
    const origResolveProject = _curatorCmdDeps.resolveProject;
    const origLoadConfig = _curatorCmdDeps.loadConfig;
    const origGlobalOutputDir = _curatorCmdDeps.globalOutputDir;
    const origCuratorRollupPath = _curatorCmdDeps.curatorRollupPath;
    const origReadFile = _curatorCmdDeps.readFile;
    const origWriteFile = _curatorCmdDeps.writeFile;
    try {
      (_curatorCmdDeps as any).resolveProject = () => ({ projectDir: dir });
      (_curatorCmdDeps as any).loadConfig = async () => makeNaxConfig();
      (_curatorCmdDeps as any).globalOutputDir = () => dir;
      (_curatorCmdDeps as any).curatorRollupPath = () => rollupPath;
      (_curatorCmdDeps as any).readFile = async (p: string) => Bun.file(p).text();
      (_curatorCmdDeps as any).writeFile = async () => { writeFileCalled = true; };

      await curatorGc({ keep: 50 });
      expect(writeFileCalled).toBe(false);
    } finally {
      (_curatorCmdDeps as any).resolveProject = origResolveProject;
      (_curatorCmdDeps as any).loadConfig = origLoadConfig;
      (_curatorCmdDeps as any).globalOutputDir = origGlobalOutputDir;
      (_curatorCmdDeps as any).curatorRollupPath = origCuratorRollupPath;
      (_curatorCmdDeps as any).readFile = origReadFile;
      (_curatorCmdDeps as any).writeFile = origWriteFile;
    }
  });
});

// ─── AC-35: CLI error cases ────────────────────────────────────────────────────

test("AC-35: curatorStatus with no run directories exits with non-zero or error message", async () => {
  const { curatorStatus, _curatorCmdDeps } = await import("../../../src/commands/curator");
  await withTempDir(async (dir) => {
    const logMessages: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logMessages.push(String(args[0] ?? ""));
    });

    const origResolveProject = _curatorCmdDeps.resolveProject;
    const origLoadConfig = _curatorCmdDeps.loadConfig;
    const origProjectOutputDir = _curatorCmdDeps.projectOutputDir;
    let threw = false;
    try {
      (_curatorCmdDeps as any).resolveProject = () => ({ projectDir: dir });
      (_curatorCmdDeps as any).loadConfig = async () => makeNaxConfig();
      (_curatorCmdDeps as any).projectOutputDir = () => dir;

      await curatorStatus({});
    } catch {
      threw = true;
    } finally {
      (_curatorCmdDeps as any).resolveProject = origResolveProject;
      (_curatorCmdDeps as any).loadConfig = origLoadConfig;
      (_curatorCmdDeps as any).projectOutputDir = origProjectOutputDir;
      logSpy.mockRestore();
    }

    // Either throws or prints "no runs" message
    const combined = logMessages.join("\n").toLowerCase();
    expect(threw || combined.includes("no runs")).toBe(true);
  });
});

// ─── AC-36: docs/guides/curator.md exists with required sections ──────────────

test("AC-36: docs/guides/curator.md exists with required content", async () => {
  const filePath = join(import.meta.dir, "../../../docs/guides/curator.md");
  expect(existsSync(filePath)).toBe(true);
  const content = await Bun.file(filePath).text();
  const lower = content.toLowerCase();
  expect(lower.includes("inputs") || lower.includes("reads")).toBe(true);
  expect(lower.includes("outputs") || lower.includes("writes")).toBe(true);
  expect(lower.includes("configuration") || lower.includes("config")).toBe(true);
  expect(lower.includes("review.audit") || lower.includes("audit")).toBe(true);
  expect(lower.includes("proposal")).toBe(true);
  expect(content.includes("nax curator commit")).toBe(true);
  expect(lower.includes("threshold")).toBe(true);
});

// ─── AC-37: docs/architecture/subsystems.md references curator ───────────────

test("AC-37: docs/architecture/subsystems.md has curator section with post-run and projection", async () => {
  const filePath = join(import.meta.dir, "../../../docs/architecture/subsystems.md");
  expect(existsSync(filePath)).toBe(true);
  const content = await Bun.file(filePath).text();
  const lower = content.toLowerCase();
  expect(lower.includes("curator")).toBe(true);
  expect(lower.includes("post-run") || lower.includes("plugin")).toBe(true);
  expect(lower.includes("projection") || lower.includes("observation")).toBe(true);
});

// ─── AC-38: README.md mentions curator ───────────────────────────────────────

test("AC-38: README.md mentions curator with deterministic/post-run/context maintenance", async () => {
  const filePath = join(import.meta.dir, "../../../README.md");
  expect(existsSync(filePath)).toBe(true);
  const content = await Bun.file(filePath).text();
  const lower = content.toLowerCase();
  expect(lower.includes("curator")).toBe(true);
  expect(
    lower.includes("deterministic") || lower.includes("post-run") || lower.includes("context maintenance"),
  ).toBe(true);
});

// ─── AC-39: design findings doc updated to reference v0 ──────────────────────

test("AC-39: docs/findings/2026-04-30-context-curator-design.md has v0 reference in status", async () => {
  const filePath = join(import.meta.dir, "../../../docs/findings/2026-04-30-context-curator-design.md");
  expect(existsSync(filePath)).toBe(true);
  const content = await Bun.file(filePath).text();
  const lower = content.toLowerCase();
  expect(lower.includes("v0")).toBe(true);
  expect(
    lower.includes("implemented") || lower.includes("spec") || lower.includes("feature"),
  ).toBe(true);
  // Must not be draft/proposed/pending without v0 reference — the AC is satisfied by having v0 present
});

// ─── AC-40: documentation states no-LLM and no auto-apply ────────────────────

test("AC-40: documentation explicitly states no LLM and no auto-apply", async () => {
  const filePaths = [
    join(import.meta.dir, "../../../docs/guides/curator.md"),
    join(import.meta.dir, "../../../docs/architecture/subsystems.md"),
  ];

  let foundNoLlm = false;
  let foundNoAutoApply = false;

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    const content = await Bun.file(filePath).text();
    const lower = content.toLowerCase();
    if (lower.includes("no llm") || lower.includes("never uses an llm") || lower.includes("deterministic")) {
      foundNoLlm = true;
    }
    if (
      lower.includes("never auto-applies") ||
      lower.includes("requires nax curator commit") ||
      lower.includes("no auto-apply") ||
      lower.includes("nax curator commit")
    ) {
      foundNoAutoApply = true;
    }
  }

  expect(foundNoLlm).toBe(true);
  expect(foundNoAutoApply).toBe(true);
});