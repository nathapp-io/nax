/**
 * Amendment B AC-51: planDigestBoost
 *
 * For stages single-session, tdd-simple, no-test, and batch the plan digest
 * is injected as a scored RawChunk (id: "plan-digest:<hash>") with a boosted
 * rawScore. For all other stages the priorStageDigest remains raw markdown only.
 *
 * nax#1759: `planDigestBoost` is resolved by both call sites
 * (stage-assembler.ts, pipeline/stages/context.ts) keying
 * `getStageContextConfig` off `ctx.routing.testStrategy` — a TestStrategy
 * value — never off the assembled stage key. `single-session` and `batch`
 * are STAGE_CONTEXT_MAP keys, not TestStrategy values, so a boost declared
 * on them is dead configuration and was removed. `tdd-simple` and `no-test`
 * ARE TestStrategy values, so their declared boost is genuinely read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeContextBundle,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
} from "@test/helpers";
import { _orchestratorDeps, ContextOrchestrator } from "@/context/engine/orchestrator";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import { getStageContextConfig } from "@/context/engine/stage-config";
import type { ContextBundle, ContextRequest } from "@/context/engine/types";
import type { RoutingResult } from "@/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_seq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const PLAN_DIGEST = "Plan summary: touch auth.ts, use _deps pattern, tests in test/unit/auth.";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "single-session",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: [],
  priorStageDigest: PLAN_DIGEST,
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage config tests
// ─────────────────────────────────────────────────────────────────────────────

describe("StageContextConfig.planDigestBoost", () => {
  // Only tdd-simple and no-test are TestStrategy values — the only two keys
  // getStageContextConfig(ctx.routing.testStrategy) can ever select for the
  // boost (nax#1759). single-session and batch used to also declare 1.5 here,
  // but neither is a TestStrategy value, so neither field was ever read —
  // dead configuration, removed.
  test.each(["tdd-simple", "no-test"])("%s has planDigestBoost >= 1.5", (stage) => {
    const cfg = getStageContextConfig(stage);
    expect(cfg.planDigestBoost).toBeGreaterThanOrEqual(1.5);
  });

  test.each(["single-session", "batch", "verify", "review-semantic", "plan", "tdd-test-writer", "tdd-implementer"])(
    "%s has planDigestBoost absent or <= 1",
    (stage) => {
      const cfg = getStageContextConfig(stage);
      expect(cfg.planDigestBoost ?? 1.0).toBeLessThanOrEqual(1.0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#1759: the boost is strategy-keyed, not stage-keyed (the actual contract)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal PipelineContext for assembleForStage, mirroring stage-assembler.test.ts's makeCtx. */
function makeAssembleCtx(testStrategy: RoutingResult["testStrategy"]) {
  const config = makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } });
  const story = makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    routing: { ...DEFAULT_TEST_ROUTING, agent: undefined, testStrategy },
    projectDir: undefined, // suppresses manifest writes in tests
    workdir: "/repo",
    hooks: { hooks: {} },
  });
}

/**
 * Mock orchestrator that captures the last assemble() request via a mutable
 * ref. Built as a real `ContextOrchestrator` instance with `assemble`
 * monkey-patched — `_stageAssemblerDeps.createOrchestrator` returns
 * `ContextOrchestrator`, and a genuine instance satisfies that return type
 * with no cast needed (unlike a structurally-mocked object literal).
 */
function makeMockOrchestrator() {
  const ref: { captured: ContextRequest | null } = { captured: null };
  const orchestrator = new ContextOrchestrator([]);
  orchestrator.assemble = async (r: ContextRequest): Promise<ContextBundle> => {
    ref.captured = r;
    return makeContextBundle({
      digest: "abc",
      manifest: {
        requestId: "req-1",
        stage: "single-session",
        totalBudgetTokens: 0,
        usedTokens: 0,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
    });
  };
  return { ref, orchestrator };
}

describe("assembleForStage — planDigestBoost is resolved from testStrategy, not the assembled stage (nax#1759)", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  });

  test("a tdd-simple story gets planDigestBoost=1.5 whether assembling 'single-session' or 'tdd-implementer'", async () => {
    const execMock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => execMock.orchestrator;
    await assembleForStage(makeAssembleCtx("tdd-simple"), "single-session");
    expect(execMock.ref.captured?.planDigestBoost).toBe(1.5);

    const tddMock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => tddMock.orchestrator;
    await assembleForStage(makeAssembleCtx("tdd-simple"), "tdd-implementer");
    expect(tddMock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("a test-after story gets no planDigestBoost, even assembling 'single-session' (the stage it maps to)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator;

    // test-after is resolveTestStrategy's fallback and a single-session mode,
    // and executionContextStage maps it to the "single-session" stage — whose
    // own entry no longer declares a boost. It has no STAGE_CONTEXT_MAP entry
    // of its own, so the strategy-keyed lookup finds nothing: a known gap
    // (ADR-010 Amendment B, nax#1759).
    await assembleForStage(makeAssembleCtx("test-after"), "single-session");

    expect(mock.ref.captured?.planDigestBoost).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: plan-digest chunk injection
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — planDigestBoost (Amendment B AC-51)", () => {
  test("plan-digest chunk is injected into includedChunks when planDigestBoost > 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeDefined();
  });

  test("plan-digest chunk appears in bundle.chunks when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    expect(chunk).toBeDefined();
    expect(chunk?.content).toBe(PLAN_DIGEST);
  });

  test("plan-digest chunk is NOT injected when planDigestBoost absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST }); // no planDigestBoost
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when planDigestBoost <= 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.0 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when priorStageDigest is absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, priorStageDigest: undefined, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("boosted plan-digest chunk has higher rawScore than session-scratch chunks (0.9)", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    // rawScore should be 0.9 * 1.5 = 1.35, exceeding normal session rawScore of 0.9
    expect(chunk?.rawScore).toBeGreaterThan(0.9);
  });

  test("plan-digest chunk appears in providerResults with providerId 'plan-digest'", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    const pr = bundle.manifest.providerResults?.find((p) => p.providerId === "plan-digest");
    expect(pr).toBeDefined();
    expect(pr?.status).toBe("ok");
  });

  test("pushMarkdown contains plan digest content when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, planDigestBoost: 1.5 });
    expect(bundle.pushMarkdown).toContain(PLAN_DIGEST);
  });
});
