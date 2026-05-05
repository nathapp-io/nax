import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

import {
  handleQueryFeatureContext,
  handleQueryNeighbor,
  PullToolBudget,
  createRunCallCounter,
} from "../../../src/context/engine/pull-tools";
import { getLogger, initLogger, resetLogger } from "../../../src/logger";
import { DispatchEventBus } from "../../../src/runtime/dispatch-events";
import type { ReviewDecisionEvent } from "../../../src/runtime/dispatch-events";
import { acceptanceStage, _acceptanceStageDeps } from "../../../src/pipeline/stages/acceptance";
import { collectObservations } from "../../../src/plugins/builtin/curator/collect";
import type { CuratorPostRunContext } from "../../../src/plugins/builtin/curator/types";
import { runHeuristics } from "../../../src/plugins/builtin/curator/heuristics";
import type { CuratorThresholds, Proposal } from "../../../src/plugins/builtin/curator/heuristics";
import { renderProposals } from "../../../src/plugins/builtin/curator/render";
import { appendToRollup } from "../../../src/plugins/builtin/curator/rollup";
import { curatorPlugin } from "../../../src/plugins/builtin/curator";
import { PluginRegistry } from "../../../src/plugins/registry";
import { NaxConfigSchema } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { curatorStatus, curatorCommit, curatorGc, _curatorCmdDeps } from "../../../src/commands/curator";
import { makeTempDir, cleanupTempDir } from "../../../test/helpers/temp";
import { makeNaxConfig, makeStory, makePRD } from "../../../test/helpers";
import { contextToolRuntimeConfigSelector } from "../../../src/config/selectors";
import type { PipelineContext } from "../../../src/pipeline/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupLogger() {
  resetLogger();
  return initLogger({ level: "info", useChalk: false });
}

function teardownLogger() {
  resetLogger();
}

function makeCuratorCtx(workdir: string, outputDir: string, overrides?: Partial<CuratorPostRunContext>): CuratorPostRunContext {
  return {
    runId: "test-run-001",
    feature: "test-feature",
    workdir,
    prdPath: join(workdir, "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 0,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: DEFAULT_CONFIG,
    outputDir,
    globalDir: join(workdir, "global"),
    projectKey: "test-project",
    curatorRollupPath: join(workdir, "rollup.jsonl"),
    ...overrides,
  } as CuratorPostRunContext;
}

const BASE_OBS_DEFAULTS = { schemaVersion: 1 as const, runId: "run-abc", featureId: "feat-1", storyId: "s1", stage: "test", payload: {} };
function makeBaseObservation(kind: string, overrides?: Record<string, unknown>) {
  return { ...BASE_OBS_DEFAULTS, ts: new Date().toISOString(), kind, ...overrides };
}
function makeReviewFindingObs(ruleId: string, storyId: string) {
  return { schemaVersion: 1 as const, runId: "run-1", featureId: "feat-1", storyId, stage: "review", ts: new Date().toISOString(), kind: "review-finding" as const, payload: { ruleId, severity: "error", file: "foo.ts", line: 1, message: "msg" } };
}

function makeAcceptanceCtx(tempDir: string, testPath: string): PipelineContext {
  const story = makeStory({ id: "US-001", status: "passed" });
  const prd = makePRD({ userStories: [story] });
  return {
    config: makeNaxConfig({ acceptance: { enabled: true, hardening: { enabled: false } } as any }),
    rootConfig: DEFAULT_CONFIG, story, prd, stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    featureDir: join(tempDir, ".nax", "features", "test-feature"),
    workdir: tempDir, projectDir: tempDir,
    acceptanceTestPaths: [{ testPath, packageDir: tempDir }],
    agentManager: {} as any, sessionManager: {} as any, runtime: {} as any,
    abortSignal: new AbortController().signal,
  } as unknown as PipelineContext;
}

// ─── AC-1 ─────────────────────────────────────────────────────────────────────

describe("AC-1: handleQueryFeatureContext storyId in logger.info data", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac1-"); setupLogger(); });
  afterEach(() => { teardownLogger(); cleanupTempDir(tempDir); });

  test("AC-1: storyId matches story.id in logger.info data object", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const story = makeStory({ id: "test-story-123" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(10, 100, counter);
    await handleQueryFeatureContext({}, story, config, tempDir, budget);
    const call = spy.mock.calls.find((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(call).toBeDefined();
    const data = call![2] as Record<string, unknown>;
    expect(data.storyId).toBe("test-story-123");
  });
});

// ─── AC-2 ─────────────────────────────────────────────────────────────────────

describe("AC-2: pull-tool handlers emit exactly one logger.info on success; zero if throws before emit", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac2-"); setupLogger(); });
  afterEach(() => { teardownLogger(); cleanupTempDir(tempDir); });

  test("AC-2: handleQueryNeighbor normal invocation → exactly one logger.info('pull-tool','invoked')", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const budget = new PullToolBudget(10, 100, createRunCallCounter());
    await handleQueryNeighbor({ filePath: "nonexistent.ts" }, tempDir, budget);
    const calls = spy.mock.calls.filter((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(calls.length).toBe(1);
  });

  test("AC-2: handleQueryNeighbor budget exhausted → zero logger.info('pull-tool','invoked') calls", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const budget = new PullToolBudget(0, 100, createRunCallCounter());
    try { await handleQueryNeighbor({ filePath: "nonexistent.ts" }, tempDir, budget); } catch {}
    const calls = spy.mock.calls.filter((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(calls.length).toBe(0);
  });

  test("AC-2: handleQueryFeatureContext normal invocation → exactly one logger.info('pull-tool','invoked')", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const story = makeStory({ id: "US-001" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    const budget = new PullToolBudget(10, 100, createRunCallCounter());
    await handleQueryFeatureContext({}, story, config, tempDir, budget);
    const calls = spy.mock.calls.filter((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(calls.length).toBe(1);
  });

  test("AC-2: handleQueryFeatureContext budget exhausted → zero logger.info('pull-tool','invoked') calls", async () => {
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const story = makeStory({ id: "US-001" });
    const config = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
    const budget = new PullToolBudget(0, 100, createRunCallCounter());
    try { await handleQueryFeatureContext({}, story, config, tempDir, budget); } catch {}
    const calls = spy.mock.calls.filter((c) => c[0] === "pull-tool" && c[1] === "invoked");
    expect(calls.length).toBe(0);
  });
});

// ─── AC-3 & AC-4: acceptance stage verdict ────────────────────────────────────

function setupAcceptanceSuite(prefix: string) {
  let tempDir = "";
  let origHardening: typeof _acceptanceStageDeps.runHardeningPass;
  beforeEach(() => {
    tempDir = makeTempDir(prefix);
    setupLogger();
    origHardening = _acceptanceStageDeps.runHardeningPass;
    _acceptanceStageDeps.runHardeningPass = async () => ({ promoted: [], discarded: [] });
  });
  afterEach(() => {
    _acceptanceStageDeps.runHardeningPass = origHardening;
    teardownLogger();
    cleanupTempDir(tempDir);
  });
  return { getTempDir: () => tempDir };
}

describe("AC-3: acceptance stage emits exactly one verdict with passed flag matching result", () => {
  const { getTempDir } = setupAcceptanceSuite("ac3-");

  test("AC-3: passing tests → { action: 'continue' }, one verdict with passed=true", async () => {
    const tempDir = getTempDir();
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const testPath = join(tempDir, ".nax-test.ts");
    writeFileSync(testPath, `import { test, expect } from "bun:test";\ntest("AC-1: x", () => { expect(1).toBe(1); });\n`);
    const result = await acceptanceStage.execute(makeAcceptanceCtx(tempDir, testPath));
    expect(result.action).toBe("continue");
    const verdicts = spy.mock.calls.filter((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect(verdicts.length).toBe(1);
    expect((verdicts[0][2] as Record<string, unknown>).passed).toBe(true);
  });

  test("AC-3: failing tests → { action: 'fail' }, one verdict with passed=false", async () => {
    const tempDir = getTempDir();
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const testPath = join(tempDir, ".nax-test.ts");
    writeFileSync(testPath, `import { test, expect } from "bun:test";\ntest("AC-1: fail", () => { expect(1).toBe(2); });\n`);
    const result = await acceptanceStage.execute(makeAcceptanceCtx(tempDir, testPath));
    expect(result.action).toBe("fail");
    const verdicts = spy.mock.calls.filter((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect(verdicts.length).toBe(1);
    expect((verdicts[0][2] as Record<string, unknown>).passed).toBe(false);
  });
});

describe("AC-4: failedACs in verdict equals parseTestFailures output for that run", () => {
  const { getTempDir } = setupAcceptanceSuite("ac4-");

  test("AC-4: all passing → failedACs is []", async () => {
    const tempDir = getTempDir();
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const testPath = join(tempDir, ".nax-test.ts");
    writeFileSync(testPath, `import { test, expect } from "bun:test";\ntest("AC-1: ok", () => { expect(1).toBe(1); });\n`);
    await acceptanceStage.execute(makeAcceptanceCtx(tempDir, testPath));
    const verdict = spy.mock.calls.find((c) => c[0] === "acceptance" && c[1] === "verdict");
    expect((verdict![2] as Record<string, unknown>).failedACs).toEqual([]);
  });

  test("AC-4: failing tests → failedACs contains AC-N identifiers", async () => {
    const tempDir = getTempDir();
    const logger = getLogger();
    const spy = spyOn(logger, "info");
    const testPath = join(tempDir, ".nax-test.ts");
    writeFileSync(testPath, `import { test, expect } from "bun:test";\ntest("AC-2: fail", () => { expect(1).toBe(2); });\ntest("AC-7: fail", () => { expect(1).toBe(3); });\n`);
    await acceptanceStage.execute(makeAcceptanceCtx(tempDir, testPath));
    const verdict = spy.mock.calls.find((c) => c[0] === "acceptance" && c[1] === "verdict");
    const failedACs = (verdict![2] as Record<string, unknown>).failedACs as string[];
    expect(failedACs.length).toBeGreaterThan(0);
    for (const acId of failedACs) { expect(acId).toMatch(/^AC-/); }
  });
});

// ─── AC-5 ─────────────────────────────────────────────────────────────────────

describe("AC-5: emitReviewDecision calls all N>=2 listeners exactly once with identical event", () => {
  test("AC-5: all three registered listeners invoked once with same event reference", () => {
    const bus = new DispatchEventBus();
    const received: ReviewDecisionEvent[] = [];
    const event: ReviewDecisionEvent = {
      kind: "review-decision", reviewer: "semantic", timestamp: Date.now(), parsed: true, result: null,
    };
    bus.onReviewDecision((e) => received.push(e));
    bus.onReviewDecision((e) => received.push(e));
    bus.onReviewDecision((e) => received.push(e));
    bus.emitReviewDecision(event);
    expect(received.length).toBe(3);
    for (const r of received) {
      expect(r).toEqual(event);
    }
  });
});

// ─── AC-6 ─────────────────────────────────────────────────────────────────────

describe("AC-6: throwing onReviewDecision listener does not stop remaining listeners", () => {
  test("AC-6: listener 1 throws, listener 2 still receives event; emitReviewDecision does not propagate error", () => {
    const bus = new DispatchEventBus();
    let secondCalled = false;
    const event: ReviewDecisionEvent = {
      kind: "review-decision", reviewer: "adversarial", timestamp: Date.now(), parsed: false, result: null,
    };
    bus.onReviewDecision(() => { throw new Error("intentional-listener-error"); });
    bus.onReviewDecision(() => { secondCalled = true; });
    expect(() => bus.emitReviewDecision(event)).not.toThrow();
    expect(secondCalled).toBe(true);
  });
});

// ─── AC-7 ─────────────────────────────────────────────────────────────────────

describe("AC-7: no cross-contamination between dispatch and review-decision listeners", () => {
  test("AC-7: DispatchEvent triggers only onDispatch handler; ReviewDecisionEvent triggers only onReviewDecision handler", () => {
    const bus = new DispatchEventBus();
    let dispatchCount = 0;
    let reviewCount = 0;
    bus.onDispatch(() => { dispatchCount++; });
    bus.onReviewDecision(() => { reviewCount++; });

    const reviewEvent: ReviewDecisionEvent = {
      kind: "review-decision", reviewer: "semantic", timestamp: Date.now(), parsed: true, result: null,
    };
    bus.emitReviewDecision(reviewEvent);
    expect(reviewCount).toBe(1);
    expect(dispatchCount).toBe(0);

    dispatchCount = 0;
    reviewCount = 0;
    bus.emitDispatch({ kind: "complete", sessionName: "s", sessionRole: "main", prompt: "", response: "", agentName: "claude", stage: "run", resolvedPermissions: { skipPermissions: false, mode: "safe" }, durationMs: 1, timestamp: Date.now() } as any);
    expect(dispatchCount).toBe(1);
    expect(reviewCount).toBe(0);
  });
});

// ─── AC-8 ─────────────────────────────────────────────────────────────────────

describe("AC-8: every Observation ts field round-trips through ISO 8601", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac8-"); });
  afterEach(() => { cleanupTempDir(tempDir); });

  test("AC-8: obs.ts round-trips through new Date().toISOString()", async () => {
    const metricsPath = join(tempDir, "metrics.json");
    writeFileSync(metricsPath, JSON.stringify({ stories: [{ storyId: "s1", featureId: "f1", status: "completed", cost: 0, tokens: 0 }] }));
    const ctx = makeCuratorCtx(tempDir, tempDir);
    const observations = await collectObservations(ctx);
    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      expect(new Date(obs.ts).toISOString()).toBe(obs.ts);
    }
  });
});

// ─── AC-9 ─────────────────────────────────────────────────────────────────────

describe("AC-9: every Observation payload is a non-null, non-array object", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac9-"); });
  afterEach(() => { cleanupTempDir(tempDir); });

  test("AC-9: all collected observations have payload as plain object", async () => {
    const metricsPath = join(tempDir, "metrics.json");
    writeFileSync(metricsPath, JSON.stringify({ stories: [{ storyId: "s1", status: "completed", cost: 0, tokens: 0 }] }));
    const ctx = makeCuratorCtx(tempDir, tempDir);
    const observations = await collectObservations(ctx);
    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      expect(typeof obs.payload).toBe("object");
      expect(obs.payload).not.toBeNull();
      expect(Array.isArray(obs.payload)).toBe(false);
    }
  });
});

// ─── AC-10 ────────────────────────────────────────────────────────────────────

describe("AC-10: collectObservations with no source directories returns [] without throwing", () => {
  test("AC-10: non-existent outputDir resolves to empty array", async () => {
    const ctx = makeCuratorCtx("/nonexistent-dir-ac10-test", "/nonexistent-dir-ac10-test");
    const observations = await collectObservations(ctx);
    expect(Array.isArray(observations)).toBe(true);
    expect(observations.length).toBe(0);
  });
});

// ─── AC-11 ────────────────────────────────────────────────────────────────────

describe("AC-11: malformed JSON in source file: no throw, excluded from results, logger.warn emitted", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac11-"); setupLogger(); });
  afterEach(() => { teardownLogger(); cleanupTempDir(tempDir); });

  test("AC-11: malformed review-audit JSON: no throw, 0 obs from bad file, one logger.warn with file path", async () => {
    const logger = getLogger();
    const warnSpy = spyOn(logger, "warn");

    const auditDir = join(tempDir, "review-audit");
    mkdirSync(auditDir, { recursive: true });
    const badFile = join(auditDir, "malformed.json");
    const goodFile = join(auditDir, "good.json");
    writeFileSync(badFile, "{ INVALID JSON !!!");
    writeFileSync(goodFile, JSON.stringify({ storyId: "s1", featureId: "f1", findings: [] }));

    const ctx = makeCuratorCtx(tempDir, tempDir);
    const observations = await collectObservations(ctx);

    // (a) did not throw — if we reach here, it passed
    // (b) no observations from bad file (bad file has no parseable findings → 0 obs from it)
    const reviewFindings = observations.filter((o) => o.kind === "review-finding");
    expect(reviewFindings.length).toBe(0); // good.json has empty findings array

    // (c) one logger.warn containing the file path
    const warns = warnSpy.mock.calls.filter((c) => JSON.stringify(c).includes("malformed.json"));
    expect(warns.length).toBe(1);
  });
});

// ─── AC-12 ────────────────────────────────────────────────────────────────────

describe("AC-12: built-in registration path yields nax-curator in getPostRunActions()", () => {
  test("AC-12: PluginRegistry with curatorPlugin has nax-curator in getPostRunActions()", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();
    const found = actions.find((a) => a.name === "nax-curator");
    expect(found).toBeDefined();
  });
});

// ─── AC-13 ────────────────────────────────────────────────────────────────────

describe("AC-13: default curator thresholds are finite numbers, matching DEFAULT_CONFIG", () => {
  test("AC-13: NaxConfigSchema.parse({}).curator.thresholds has all 6 keys as finite numbers equal to DEFAULT_CONFIG", () => {
    const parsed = NaxConfigSchema.parse({});
    const thresholds = (parsed as any).curator?.thresholds;
    expect(thresholds).toBeDefined();
    const keys = ["repeatedFinding", "emptyKeyword", "rectifyAttempts", "escalationChain", "staleChunkRuns", "unchangedOutcome"];
    for (const key of keys) {
      expect(typeof thresholds[key]).toBe("number");
      expect(isFinite(thresholds[key])).toBe(true);
    }
    expect(thresholds).toEqual((DEFAULT_CONFIG as any).curator.thresholds);
  });
});

// ─── AC-14 ────────────────────────────────────────────────────────────────────

describe("AC-14: relative curator.rollupPath in safeParse returns failure with rollupPath issue", () => {
  test("AC-14: { curator: { rollupPath: 'relative/path/rollup.jsonl' } } → success:false with curator.rollupPath in issues", () => {
    const result = NaxConfigSchema.safeParse({ curator: { rollupPath: "relative/path/rollup.jsonl" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasRollupIssue = result.error.issues.some(
        (issue) => issue.path.some((p) => p === "rollupPath"),
      );
      expect(hasRollupIssue).toBe(true);
    }
  });
});

// ─── AC-15 ────────────────────────────────────────────────────────────────────

describe("AC-15: runHeuristics([]) returns empty array", () => {
  test("AC-15: runHeuristics([], fullThresholds) returns []", () => {
    const thresholds: CuratorThresholds = {
      repeatedFinding: 3, emptyKeyword: 2, rectifyAttempts: 3,
      escalationChain: 2, staleChunkRuns: 5, unchangedOutcome: 2,
    };
    const result = runHeuristics([], thresholds);
    expect(result).toHaveLength(0);
  });
});

// ─── AC-16 ────────────────────────────────────────────────────────────────────

describe("AC-16: missing threshold keys use documented defaults; explicit threshold=2 fires at 2 but not 1", () => {
  test("AC-16: runHeuristics uses defaults when threshold keys are absent (cast to any)", () => {
    const partial = {} as CuratorThresholds;
    const result = runHeuristics([], partial);
    expect(Array.isArray(result)).toBe(true);
  });

  test("AC-16: H1 fires at count=2 (threshold=2) and not at count=1", () => {
    const thresholds: CuratorThresholds = {
      repeatedFinding: 2, emptyKeyword: 2, rectifyAttempts: 3,
      escalationChain: 2, staleChunkRuns: 5, unchangedOutcome: 2,
    };
    const oneObs = [makeReviewFindingObs("rule-X", "s1")];
    const h1AtOne = runHeuristics(oneObs, thresholds).filter((p) => p.id === "H1");
    expect(h1AtOne.length).toBe(0);

    const twoObs = [makeReviewFindingObs("rule-X", "s1"), makeReviewFindingObs("rule-X", "s2")];
    const h1AtTwo = runHeuristics(twoObs, thresholds).filter((p) => p.id === "H1");
    expect(h1AtTwo.length).toBeGreaterThan(0);
  });
});

// ─── AC-17 ────────────────────────────────────────────────────────────────────

describe("AC-17: renderProposals contains ISO 8601 UTC timestamp", () => {
  test("AC-17: output contains /\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z/", () => {
    const result = renderProposals([], "run-001", 0);
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
  });
});

// ─── AC-18 ────────────────────────────────────────────────────────────────────

describe("AC-18: two proposals with same canonicalFile appear under exactly one heading", () => {
  test("AC-18: single heading for shared canonicalFile, both proposals present", () => {
    const proposals: Proposal[] = [
      { id: "H1", severity: "HIGH", target: { canonicalFile: "rules/test.md", action: "add" }, description: "Proposal one", evidence: "", sourceKinds: [], storyIds: ["s1"] },
      { id: "H2", severity: "MED", target: { canonicalFile: "rules/test.md", action: "add" }, description: "Proposal two", evidence: "", sourceKinds: [], storyIds: ["s2"] },
    ];
    const result = renderProposals(proposals, "run-001", 2);
    const headingMatches = result.match(/^#{2,3}.*rules\/test\.md/gm) ?? [];
    expect(headingMatches.length).toBe(1);
    expect(result).toContain("Proposal one");
    expect(result).toContain("Proposal two");
  });
});

// ─── AC-19 ────────────────────────────────────────────────────────────────────

describe("AC-19: appendToRollup writes valid JSON lines each < 4096 bytes; sequential writes accumulate", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = makeTempDir("ac19-"); });
  afterEach(() => { cleanupTempDir(tempDir); });

  test("AC-19: two sequential appendToRollup calls produce count1+count2 lines, each < 4096 bytes", async () => {
    const rollupPath = join(tempDir, "rollup.jsonl");
    const obs1 = makeBaseObservation("verdict", { payload: { status: "completed", cost: 0, tokens: 0 } }) as any;
    const obs2 = makeBaseObservation("verdict", { runId: "run-bcd", payload: { status: "failed", cost: 1, tokens: 100 } }) as any;
    const obs3 = makeBaseObservation("verdict", { runId: "run-cde", payload: { status: "skipped", cost: 0, tokens: 0 } }) as any;

    await appendToRollup([obs1, obs2], rollupPath);
    await appendToRollup([obs3], rollupPath);

    const content = readFileSync(rollupPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(3);

    for (const line of lines) {
      const bytes = new TextEncoder().encode(line).byteLength;
      expect(bytes).toBeLessThan(4096);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ─── AC-20 ────────────────────────────────────────────────────────────────────

describe("AC-20: curatorStatus with no runs writes non-empty message to stdout, no throw", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac20-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-20: no runs directory → stdout contains 'no runs' or 'not found', process continues", async () => {
    const logSpy = spyOn(console, "log");
    _curatorCmdDeps.resolveProject = () => ({ projectDir: tempDir, configPath: join(tempDir, "config.json") });
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.projectOutputDir = () => join(tempDir, "nonexistent-output");

    await curatorStatus({});

    const combined = logSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined.toLowerCase()).toMatch(/no runs|not found/);
  });
});

// ─── AC-21 ────────────────────────────────────────────────────────────────────

describe("AC-21: curatorStatus reads observations.jsonl, proposals absent → message about no proposals", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac21-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-21: observations.jsonl present, proposals absent → message about absent proposals, counts printed", async () => {
    const logSpy = spyOn(console, "log");
    const runId = "test-run-001";
    const runDir = join(tempDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const obs = makeBaseObservation("verdict", { payload: { status: "completed", cost: 0, tokens: 0 } });
    writeFileSync(join(runDir, "observations.jsonl"), JSON.stringify(obs) + "\n");

    _curatorCmdDeps.resolveProject = () => ({ projectDir: tempDir, configPath: join(tempDir, "config.json") });
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.projectOutputDir = () => tempDir;

    await curatorStatus({});

    const combined = logSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined.toLowerCase()).toMatch(/no proposals|not found/);
    expect(combined).toContain("1"); // observation count mentioned
  });
});

// ─── AC-22 ────────────────────────────────────────────────────────────────────

describe("AC-22: curatorCommit processes only checked [x] lines from proposals markdown", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac22-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-22: mixed [x]/[ ]/heading/blank lines → only [x] count applied", async () => {
    const logSpy = spyOn(console, "log");
    const runId = "run-commit-01";
    const runDir = join(tempDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const markdown = [
      "# Curator Proposals",
      "",
      "> generated at 2026-01-01T00:00:00Z",
      "",
      "## add — Add suggestions",
      "",
      "### .nax/features/test/context.md",
      "",
      "- [x] [HIGH] H1: checked proposal one — stories: s1",
      "- [ ] [MED] H2: unchecked proposal — stories: s2",
      "- [x] [LOW] H3: checked proposal two — stories: s3",
      "",
      "## advisory — Advisory",
      "",
      "### .nax/rules/notes.md",
      "",
      "- [ ] [LOW] H6: unchecked advisory — stories: s4",
      "",
    ].join("\n");
    writeFileSync(join(runDir, "curator-proposals.md"), markdown);

    const appendedFiles: string[] = [];
    _curatorCmdDeps.resolveProject = () => ({ projectDir: tempDir, configPath: join(tempDir, "config.json") });
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.projectOutputDir = () => tempDir;
    _curatorCmdDeps.readFile = async (p: string) => {
      try { return readFileSync(p, "utf-8"); } catch { return ""; }
    };
    _curatorCmdDeps.appendFile = async (p: string, _content: string) => { appendedFiles.push(p); };
    _curatorCmdDeps.openInEditor = async () => {};

    await curatorCommit({ runId });

    const combined = logSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    // 2 checked lines → "Applied 2 proposal(s)"
    expect(combined).toMatch(/applied 2 proposal/i);
  });
});

// ─── AC-23 ────────────────────────────────────────────────────────────────────

describe("AC-23: curatorCommit with invalid runId produces error message", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac23-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-23: non-existent runId → error message containing runId, no file changes", async () => {
    const logSpy = spyOn(console, "log");
    const invalidRunId = "does-not-exist-xyz";
    const writes: string[] = [];

    _curatorCmdDeps.resolveProject = () => ({ projectDir: tempDir, configPath: join(tempDir, "config.json") });
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.projectOutputDir = () => tempDir;
    _curatorCmdDeps.readFile = async () => { throw new Error("not found"); };
    _curatorCmdDeps.writeFile = async (p: string) => { writes.push(p); };

    let threw = false;
    try {
      await curatorCommit({ runId: invalidRunId });
    } catch {
      threw = true;
    }

    if (!threw) {
      const combined = logSpy.mock.calls.map((c) => c.join(" ")).join(" ");
      expect(combined).toContain(invalidRunId);
    }
    expect(writes.length).toBe(0);
  });
});

// ─── AC-24 ────────────────────────────────────────────────────────────────────

describe("AC-24: curatorGc keep=N with fewer than N runIds leaves rollup unchanged", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac24-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-24: 2 distinct runIds in rollup, keep=5 → file content unchanged", async () => {
    const rollupPath = join(tempDir, "rollup.jsonl");
    const obs1 = makeBaseObservation("verdict", { runId: "run-a", payload: { status: "completed", cost: 0, tokens: 0 } });
    const obs2 = makeBaseObservation("verdict", { runId: "run-b", payload: { status: "completed", cost: 0, tokens: 0 } });
    const initialContent = [JSON.stringify(obs1), JSON.stringify(obs2)].join("\n") + "\n";
    writeFileSync(rollupPath, initialContent);

    _curatorCmdDeps.resolveProject = () => ({ projectDir: tempDir, configPath: join(tempDir, "config.json") });
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.globalOutputDir = () => tempDir;
    _curatorCmdDeps.curatorRollupPath = () => rollupPath;
    _curatorCmdDeps.readFile = async (p: string) => readFileSync(p, "utf-8");
    _curatorCmdDeps.writeFile = async (p: string, content: string) => writeFileSync(p, content);

    await curatorGc({ keep: 5 });

    const after = readFileSync(rollupPath, "utf-8");
    expect(after).toBe(initialContent);
  });
});

// ─── AC-25 ────────────────────────────────────────────────────────────────────

describe("AC-25: project=undefined → resolveProject called with CWD-based argument", () => {
  let tempDir: string;
  let savedDeps: typeof _curatorCmdDeps;
  beforeEach(() => {
    tempDir = makeTempDir("ac25-");
    savedDeps = { ..._curatorCmdDeps };
  });
  afterEach(() => {
    Object.assign(_curatorCmdDeps, savedDeps);
    cleanupTempDir(tempDir);
  });

  test("AC-25: curatorStatus project=undefined → resolveProject receives {dir: undefined}", async () => {
    const resolveArgs: Array<{ dir?: string }> = [];
    _curatorCmdDeps.resolveProject = (opts) => { resolveArgs.push(opts ?? {}); return { projectDir: tempDir, configPath: join(tempDir, "c.json") }; };
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.projectOutputDir = () => join(tempDir, "output");

    try { await curatorStatus({}); } catch {}
    expect(resolveArgs.length).toBeGreaterThan(0);
    expect(resolveArgs[0].dir).toBeUndefined();
  });

  test("AC-25: curatorGc project=undefined → resolveProject receives {dir: undefined}", async () => {
    const resolveArgs: Array<{ dir?: string }> = [];
    _curatorCmdDeps.resolveProject = (opts) => { resolveArgs.push(opts ?? {}); return { projectDir: tempDir, configPath: join(tempDir, "c.json") }; };
    _curatorCmdDeps.loadConfig = async () => DEFAULT_CONFIG as any;
    _curatorCmdDeps.globalOutputDir = () => tempDir;
    _curatorCmdDeps.curatorRollupPath = () => join(tempDir, "rollup.jsonl");
    _curatorCmdDeps.readFile = async () => null as any;

    try { await curatorGc({}); } catch {}
    expect(resolveArgs.length).toBeGreaterThan(0);
    expect(resolveArgs[0].dir).toBeUndefined();
  });
});

// ─── AC-26–28: Documentation checks ─────────────────────────────────────────

const CURATOR_MD_PATH = join(import.meta.dir, "../../../docs/guides/curator.md");

describe("AC-26: docs/guides/curator.md contains project and global curator artifact paths", () => {
  test("AC-26: document contains '.nax/curator/' and '~/.nax/curator/' (or equivalent global path)", () => {
    const content = readFileSync(CURATOR_MD_PATH, "utf-8");
    expect(content).toContain(".nax/curator/");
    const hasGlobalPath = content.includes("~/.nax/curator/") || content.includes("~/.nax/global/curator/");
    expect(hasGlobalPath).toBe(true);
  });
});

describe("AC-27: docs/guides/curator.md contains curator.enabled and disabledPlugins with nax-curator", () => {
  test("AC-27: document has curator.enabled and disabledPlugins nax-curator in separate sections", () => {
    const content = readFileSync(CURATOR_MD_PATH, "utf-8");
    const hasCuratorEnabled = content.includes("curator.enabled") || content.includes('"enabled": false');
    expect(hasCuratorEnabled).toBe(true);
    expect(content).toContain("disabledPlugins");
    expect(content).toContain("nax-curator");
  });
});

describe("AC-28: docs/guides/curator.md warning section mentions sensitive content and sharing within 10 lines", () => {
  test("AC-28: warning/caution/note section references sensitive content and intentional sharing within 10 lines", () => {
    const content = readFileSync(CURATOR_MD_PATH, "utf-8");
    const lines = content.split("\n");
    const sensitiveTerms = ["sensitive", "project path", "story content", "context"];
    const sharingTerms = ["sharing", "intentional", "share"];
    const warningTerms = ["warning", "caution", "note", ">"];

    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const lineWindow = lines.slice(i, i + 10).join(" ").toLowerCase();
      const hasWarning = warningTerms.some((t) => lineWindow.includes(t));
      const hasSensitive = sensitiveTerms.some((t) => lineWindow.includes(t));
      const hasSharing = sharingTerms.some((t) => lineWindow.includes(t));
      if (hasWarning && hasSensitive && hasSharing) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});