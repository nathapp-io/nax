/**
 * Workflow context stage (US-004)
 *
 * In workflow mode the brief carries its own feature context, so the context
 * stage must not boot the v2 orchestrator at all: its pull tools
 * (`query_neighbor`, `query_scratch`, `query_feature_context`) were called 0
 * times in 6,394 audited sessions. `workflowContextStage` therefore allocates
 * the story session and fetches the feature chunks through
 * `FeatureContextProviderV2` directly, leaving `ctx.contextBundle`,
 * `ctx.scopeFiles` and `ctx.resolvedTestPatterns` untouched.
 *
 * Push mode (`context.rules.delivery: "push"`) and v2-disabled runs fall back
 * to today's `contextStage`, unchanged.
 *
 * AC-1 and AC-2 are the pipeline-wiring half; AC-3..AC-12 pin the stage body.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeContextOrchestrator,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
  withWarnSpy,
} from "@test/helpers";
import { FeatureContextProvider } from "@/context";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "@/context/engine";
import { _contextStageDeps, getWorkflowPipeline } from "@/pipeline/stages";
import { _contextSessionDeps } from "@/pipeline/stages/context-session";
import { _workflowContextStageDeps, workflowContextStage } from "@/pipeline/stages/workflow-context";
import type { PipelineContext } from "@/pipeline/types";

const STUB_UUID = "11111111-2222-3333-4444-555555555555";

let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
let origV1FeatureProvider: typeof _contextStageDeps.v1FeatureProvider;
let origReadDigest: typeof _contextStageDeps.readDigest;
let origWriteDigest: typeof _contextStageDeps.writeDigest;
let origFeatureContextProvider: typeof _workflowContextStageDeps.featureContextProvider;
let origUuid: typeof _contextSessionDeps.uuid;

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-workflow-context-test-");
  origCreateOrchestrator = _contextStageDeps.createOrchestrator;
  origV1FeatureProvider = _contextStageDeps.v1FeatureProvider;
  origReadDigest = _contextStageDeps.readDigest;
  origWriteDigest = _contextStageDeps.writeDigest;
  origFeatureContextProvider = _workflowContextStageDeps.featureContextProvider;
  origUuid = _contextSessionDeps.uuid;
  // The v2 fallback paths may read/write session scratch; keep them disk-free.
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
});

afterEach(() => {
  _contextStageDeps.createOrchestrator = origCreateOrchestrator;
  _contextStageDeps.v1FeatureProvider = origV1FeatureProvider;
  _contextStageDeps.readDigest = origReadDigest;
  _contextStageDeps.writeDigest = origWriteDigest;
  _workflowContextStageDeps.featureContextProvider = origFeatureContextProvider;
  _contextSessionDeps.uuid = origUuid;
  cleanupTempDir(tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return makeTestContext({
    // `context.rules.delivery` defaults to "index" — the mode under test.
    config: makeNaxConfig({ context: { v2: { enabled: true } } }),
    story: makeStory({ id: "US-004" }),
    projectDir: tmpDir,
    workdir: tmpDir,
    featureDir: join(tmpDir, ".nax", "features", "lazy-rules-delivery"),
    ...overrides,
  });
}

function makeChunk(id: string, content: string): RawChunk {
  return { id, kind: "feature", scope: "feature", role: ["implementer"], content, tokens: 10, rawScore: 1 };
}

function makeStubProvider(fetch: (request: ContextRequest) => Promise<ContextProviderResult>): IContextProvider {
  return { id: "feature-context", kind: "feature", fetch };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 / AC-2 — pipeline wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("workflow pipeline — context stage selection", () => {
  test("AC-1: stage names are queue-check, routing, constitution, context, workflow, completion", () => {
    expect(getWorkflowPipeline().map((stage) => stage.name)).toEqual([
      "queue-check",
      "routing",
      "constitution",
      "context",
      "workflow",
      "completion",
    ]);
  });

  test("AC-2: the context entry is workflowContextStage", () => {
    const contextEntry = getWorkflowPipeline().find((stage) => stage.name === "context");
    expect(contextEntry).toBe(workflowContextStage);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 / AC-4 — index mode never boots the v2 orchestrator
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — delivery: 'index' (AC-3, AC-4)", () => {
  test("AC-3: calls _contextStageDeps.createOrchestrator zero times", async () => {
    const createOrchestrator = mock(() => makeContextOrchestrator());
    _contextStageDeps.createOrchestrator = createOrchestrator;
    let fetchCalls = 0;
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => {
        fetchCalls++;
        return { chunks: [makeChunk("feature-context:a", "A body")] };
      });

    const result = await workflowContextStage.execute(makeCtx());

    expect(createOrchestrator).toHaveBeenCalledTimes(0);
    // Non-vacuous: the index path really ran and really fetched.
    expect(fetchCalls).toBe(1);
    expect(result).toEqual({ action: "continue" });
  });

  test("AC-4: leaves ctx.contextBundle undefined", async () => {
    _contextStageDeps.createOrchestrator = mock(() => makeContextOrchestrator());
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => ({ chunks: [makeChunk("feature-context:a", "A body")] }));

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(ctx.contextBundle).toBeUndefined();
  });

  test("AC-3/AC-4 (boundary): no manifest, digest, scopeFiles or resolvedTestPatterns is written in index mode", async () => {
    _contextStageDeps.createOrchestrator = mock(() => makeContextOrchestrator());
    let digestWrites = 0;
    _contextStageDeps.writeDigest = async () => {
      digestWrites++;
    };
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => ({ chunks: [makeChunk("feature-context:a", "A body")] }));

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(ctx.contextBundle).toBeUndefined();
    expect(ctx.scopeFiles).toBeUndefined();
    expect(ctx.resolvedTestPatterns).toBeUndefined();
    expect(digestWrites).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 / AC-6 — the feature-context fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — feature context fetch (AC-5, AC-6)", () => {
  test("AC-5: ctx.featureContextMarkdown is chunk A's content, a blank line, then chunk B's content", async () => {
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => ({
        chunks: [makeChunk("feature-context:a", "A body"), makeChunk("feature-context:b", "B body")],
      }));

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(ctx.featureContextMarkdown).toBe("A body\n\nB body");
  });

  test("AC-5 (boundary): no chunk returned leaves ctx.featureContextMarkdown undefined", async () => {
    _workflowContextStageDeps.featureContextProvider = () => makeStubProvider(async () => ({ chunks: [] }));

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(ctx.featureContextMarkdown).toBeUndefined();
  });

  test("AC-6: the fetch receives stage 'context' and repoRoot = ctx.projectDir", async () => {
    const requests: ContextRequest[] = [];
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async (request) => {
        requests.push(request);
        return { chunks: [] };
      });

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.stage).toBe("context");
    expect(requests[0]?.repoRoot).toBe(ctx.projectDir);
    // The remaining fields the story brief names, derived as runV2Path derives them.
    expect(requests[0]?.storyId).toBe("US-004");
    expect(requests[0]?.packageDir).toBe(ctx.workdir);
    expect(requests[0]?.featureId).toBe("lazy-rules-delivery");
    expect(requests[0]?.role).toBe("implementer");
  });

  test("AC-6 (boundary): budgetTokens honours context.v2.stages.context.budgetTokens", async () => {
    const requests: ContextRequest[] = [];
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async (request) => {
        requests.push(request);
        return { chunks: [] };
      });
    const baseConfig = makeNaxConfig({ context: { v2: { enabled: true } } });

    await workflowContextStage.execute(
      makeCtx({
        config: makeNaxConfig({
          context: { v2: { enabled: true, stages: { context: { budgetTokens: 1234 } } } },
        }),
      }),
    );

    expect(requests[0]?.budgetTokens).toBe(1234);
    expect(requests[0]?.budgetTokens).not.toBe(baseConfig.context.featureEngine?.budgetTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — session allocation without the orchestrator
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — session allocation (AC-7)", () => {
  test("AC-7: sets ctx.sessionId, ctx.sessionScratchDir and ctx.contextToolRunCounter when none is set", async () => {
    _contextSessionDeps.uuid = () => STUB_UUID;
    _workflowContextStageDeps.featureContextProvider = () => makeStubProvider(async () => ({ chunks: [] }));

    // A feature-less PRD drives the uuid branch of the shared allocator, so the
    // assertion is deterministic without a SessionManager fixture.
    const ctx = makeCtx({ prd: makePRD({ feature: undefined }), featureDir: undefined });

    await workflowContextStage.execute(ctx);

    expect(ctx.sessionId).toBe(STUB_UUID);
    expect(ctx.sessionScratchDir).toContain(join("sessions", STUB_UUID));
    expect(ctx.contextToolRunCounter).toEqual({ count: 0, calls: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — delivery: "push" restores today's behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — delivery: 'push' (AC-8)", () => {
  test("AC-8: calls _contextStageDeps.createOrchestrator once", async () => {
    const createOrchestrator = mock(() => makeContextOrchestrator());
    _contextStageDeps.createOrchestrator = createOrchestrator;
    let featureContextFetches = 0;
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => {
        featureContextFetches++;
        return { chunks: [] };
      });

    const ctx = makeCtx({
      config: makeNaxConfig({ context: { v2: { enabled: true }, rules: { delivery: "push" } } }),
    });
    const result = await workflowContextStage.execute(ctx);

    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(featureContextFetches).toBe(0);
    expect(result).toEqual({ action: "continue" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — v2 disabled falls back to the v1 path
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — context.v2.enabled: false (AC-9)", () => {
  test("AC-9: calls _contextStageDeps.v1FeatureProvider once", async () => {
    const v1FeatureProvider = mock(() => new FeatureContextProvider());
    _contextStageDeps.v1FeatureProvider = v1FeatureProvider;

    const ctx = makeCtx({ config: makeNaxConfig({ context: { v2: { enabled: false } } }) });
    const result = await workflowContextStage.execute(ctx);

    expect(v1FeatureProvider).toHaveBeenCalledTimes(1);
    expect(ctx.contextBundle).toBeUndefined();
    expect(result).toEqual({ action: "continue" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default-provider wiring (supplementary — covers the un-stubbed factory)
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — default provider wiring", () => {
  test("enabled: is always enabled", () => {
    expect(workflowContextStage.enabled(makeCtx())).toBe(true);
  });

  test("default provider reads the feature's context.md from disk", async () => {
    const featurePath = join(tmpDir, ".nax", "features", "lazy-rules-delivery");
    await mkdir(featurePath, { recursive: true });
    await Bun.write(
      join(featurePath, "prd.json"),
      JSON.stringify({
        project: "test-project",
        feature: "lazy-rules-delivery",
        userStories: [{ id: "US-004" }],
      }),
    );
    await Bun.write(join(featurePath, "context.md"), "Discussed: workflow mode drops the pull tools.");

    // `featureEngine.enabled` gates the v1 reader the adapter wraps.
    const ctx = makeCtx({
      config: makeNaxConfig({ context: { v2: { enabled: true }, featureEngine: { enabled: true } } }),
    });
    await workflowContextStage.execute(ctx);

    expect(ctx.featureContextMarkdown).toContain("workflow mode drops the pull tools");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 / AC-11 / AC-12 — a throwing provider is non-fatal
// ─────────────────────────────────────────────────────────────────────────────

describe("workflowContextStage — provider fetch throws (AC-10, AC-11, AC-12)", () => {
  function stubThrowingProvider(): void {
    _workflowContextStageDeps.featureContextProvider = () =>
      makeStubProvider(async () => {
        throw new Error("feature context provider exploded");
      });
  }

  test("AC-10: returns { action: 'continue' }", async () => {
    stubThrowingProvider();

    expect(await workflowContextStage.execute(makeCtx())).toEqual({ action: "continue" });
  });

  test("AC-11: leaves ctx.featureContextMarkdown undefined", async () => {
    stubThrowingProvider();

    const ctx = makeCtx();
    await workflowContextStage.execute(ctx);

    expect(ctx.featureContextMarkdown).toBeUndefined();
  });

  test("AC-12: logs exactly one warn whose data's first key is storyId", async () => {
    stubThrowingProvider();

    await withWarnSpy(async (warnSpy) => {
      await workflowContextStage.execute(makeCtx());

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const data = warnSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(Object.keys(data)[0]).toBe("storyId");
      expect(data.storyId).toBe("US-004");
    });
  });
});
