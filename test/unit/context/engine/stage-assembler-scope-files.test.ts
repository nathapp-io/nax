/**
 * Unit tests for assembleForStage — Story: Resolve and thread complete scope files.
 *
 * AC-10: assembleForStage() builds a ContextRequest whose scopeFiles equals
 *        StageAssembleOptions.scopeFiles.
 * AC-11: assembleForStage() preserves touchedFiles equal to
 *        getContextFiles(story) when scopeFiles is supplied.
 *
 * Mirrors the pattern from test/unit/context/engine/stage-assembler.test.ts:
 * capture the ContextRequest via a mock orchestrator and assert on the
 * captured fields directly. The resolver is NOT invoked here — assembleForStage
 * only consumes what the caller threads through StageAssembleOptions.
 *
 * Absorbs the exec-root (US-001/AC8-AC10), provider-weights invalidation
 * (PERF-1) and extra-provider-ids (#662) satellite suites.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeContextBundle,
  makeContextOrchestrator,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
  withDepsRestore,
} from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { ContextV2ConfigSchema } from "@/config/schemas";
import { ProviderWeightsCache } from "@/context/engine";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import type { ContextBundle, ContextRequest } from "@/context/engine/types";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";
import type { PackageView } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;
let origReaddir: typeof _stageAssemblerDeps.readdir;
let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;

beforeEach(() => {
  origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
  origReaddir = _stageAssemblerDeps.readdir;
  origReadDescriptor = _stageAssemblerDeps.readDescriptor;
  // Suppress disk discovery — keep tests hermetic.
  _stageAssemblerDeps.readdir = async () => {
    throw new Error("ENOENT");
  };
  _stageAssemblerDeps.readDescriptor = async () => null;
});

afterEach(() => {
  _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  _stageAssemblerDeps.readdir = origReaddir;
  _stageAssemblerDeps.readDescriptor = origReadDescriptor;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — scope-files suite (US-005)
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/repo";
const STORY_ID = "US-005";

const makeScopeStory = (overrides: Partial<UserStory> = {}): UserStory => makeStory({ id: STORY_ID, ...overrides });

function makeCtx(story: UserStory): PipelineContext {
  return makeTestContext({
    config: makeNaxConfig({
      context: { v2: { enabled: true, pluginProviders: [] } },
      agent: { default: "claude" },
    }),
    rootConfig: makeNaxConfig({ agent: { default: "claude" } }),
    prd: makePRD({ feature: "test-feature" }),
    story,
    stories: [],
    routing: { ...DEFAULT_TEST_ROUTING, testStrategy: "tdd-simple" },
    projectDir: PROJECT_DIR,
    workdir: PROJECT_DIR,
  });
}

function makeMockOrchestrator() {
  const ref: { captured: ContextRequest | null } = { captured: null };
  const orchestrator = {
    assemble: async (r: ContextRequest): Promise<ContextBundle> => {
      ref.captured = r;
      return makeContextBundle({
        pushMarkdown: "",
        digest: "abc",
        manifest: {
          requestId: "req-1",
          stage: "execution",
          totalBudgetTokens: 0,
          usedTokens: 0,
          includedChunks: [],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 0,
          buildMs: 0,
        },
      });
    },
  };
  return { ref, orchestrator };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 / AC-11 — scope-files suite
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — scope files threading (AC-10 / AC-11)", () => {
  test("AC-10: builds ContextRequest whose scopeFiles equals StageAssembleOptions.scopeFiles", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const scope = ["src/one.ts", "src/two.ts", "src/three.ts"];
    const story = makeScopeStory({ contextFiles: ["src/one.ts"] });
    await assembleForStage(makeCtx(story), "execution", { scopeFiles: scope });

    expect(mock.ref.captured?.scopeFiles).toEqual(scope);
  });

  test("AC-10 (boundary): builds ContextRequest whose scopeFiles equals a single-entry scope list", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const scope = ["src/only.ts"];
    const story = makeScopeStory();
    await assembleForStage(makeCtx(story), "execution", { scopeFiles: scope });

    expect(mock.ref.captured?.scopeFiles).toEqual(["src/only.ts"]);
  });

  test("AC-11: preserves touchedFiles equal to getContextFiles(story) when scopeFiles is supplied", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const story = makeScopeStory({
      contextFiles: ["src/declared-a.ts", "src/declared-b.ts"],
    });
    await assembleForStage(makeCtx(story), "execution", {
      scopeFiles: ["src/from-scope-resolver.ts"],
    });

    // AC-11 contract: touchedFiles continues to come from getContextFiles(story),
    // unchanged, even when scopeFiles is also supplied.
    expect(mock.ref.captured?.touchedFiles).toEqual(["src/declared-a.ts", "src/declared-b.ts"]);
  });

  test("AC-11 (boundary): touchedFiles defaults to getContextFiles(story) when caller omits touchedFiles option", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const story = makeScopeStory({
      contextFiles: ["src/default-touched.ts"],
    });
    // No touchedFiles override, no scopeFiles — touchedFiles should still
    // equal getContextFiles(story).
    await assembleForStage(makeCtx(story), "execution");

    expect(mock.ref.captured?.touchedFiles).toEqual(["src/default-touched.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 / AC8-AC10 — execRoot suite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * US-001 / AC8-AC10: assembleForStage populates ContextRequest.execRoot from
 * `storyExecRoot(ctx.packageView)` whenever a packageView is available.
 * Without a packageView the field is OMITTED — consumers fall back to
 * repoRoot, which is today's behaviour. The worktree-prefixed case must
 * surface the worktree root (NOT the main checkout) so context providers
 * resolve against the worktree the story actually executes in.
 */

function makeExecRootCtx(
  overrides: { projectDir?: string; workdir?: string; storyWorkdir?: string } = {},
): PipelineContext {
  const config = makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } });
  const story = overrides.storyWorkdir
    ? makeStory({ id: "US-001", workdir: overrides.storyWorkdir, workdirSource: "stated" })
    : makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    projectDir: overrides.projectDir,
    workdir: overrides.workdir ?? "/repo",
    hooks: { hooks: {} },
  });
}

// AC10 is read strictly: with no packageView on the PipelineContext the
// producer omits `execRoot` entirely (the `storyExecRoot(ctx.packageView)`
// derivation has no input), so consumers fall back to repoRoot — today's
// behaviour for the pull-tool handlers, which carry no story and no
// packageView. The context stage's producer is pinned to the same strict
// shape in `context-request-workdir-fields.test.ts`.

/** Build a PackageView fixture for the worktree-resolution tests. */
function makePackageView(packageDir: string, repoRoot: string, config: PipelineContext["config"]): PackageView {
  return {
    packageDir,
    relativeFromRoot: packageDir,
    repoRoot,
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
}

/** Capture the ContextRequest passed to orchestrator.assemble(). */
function captureOrchestratorRequest(): { captured: ContextRequest | null } {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _stageAssemblerDeps.createOrchestrator = mock(() =>
    makeContextOrchestrator({
      assemble: async (req: ContextRequest) => {
        ref.captured = req;
        return makeContextBundle({});
      },
    }),
  );
  return ref;
}

describe("assembleForStage — US-001 execRoot propagation", () => {
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

  test("AC8: packageView with a .nax-wt prefix yields execRoot = <root>/.nax-wt/<storyId>", async () => {
    const capture = captureOrchestratorRequest();

    const ctx = makeExecRootCtx({
      projectDir: "/repo",
      workdir: "/repo/.nax-wt/US-001/packages/app",
      storyWorkdir: "packages/app",
    });
    // Iteration-runner stamps packageView with the RELATIVE packageDir and
    // the absolute repoRoot. storyExecRoot is then responsible for assembling
    // the worktree root, exactly like the production caller at
    // src/operations/call-run-options.ts:57.
    ctx.packageView = makePackageView(".nax-wt/US-001/packages/app", "/repo", ctx.config);

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBe("/repo/.nax-wt/US-001");
  });

  test("AC9: packageView with no .nax-wt segment yields execRoot = repoRoot", async () => {
    const capture = captureOrchestratorRequest();

    const ctx = makeExecRootCtx({
      projectDir: "/repo",
      workdir: "/repo/packages/app",
      storyWorkdir: "packages/app",
    });
    ctx.packageView = makePackageView("packages/app", "/repo", ctx.config);

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBe("/repo");
  });

  test("AC10: with no packageView on the pipeline context, execRoot is unset", async () => {
    const capture = captureOrchestratorRequest();

    // Pull-tool handlers carry no story and no packageView — their
    // ContextRequest must NOT carry execRoot, so consumers fall back to
    // repoRoot (today's behaviour).
    const ctx = makeExecRootCtx({
      projectDir: "/repo",
      workdir: "/repo",
    });
    // Defensive: explicitly remove any packageView set by the factory.
    ctx.packageView = undefined;

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-1 — provider-weights suite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PERF-1 — assembleForStage must not invalidate the provider-weights cache.
 *
 * writeContextManifest persists a manifest that carries no chunkEffectiveness,
 * the only field deriveProviderWeights reads. Invalidating here discarded the
 * weights loadOrGet had just derived without any fresher signal; invalidation
 * now lives in annotateManifestEffectiveness, where effectiveness is written.
 */

class SpyProviderWeightsCache extends ProviderWeightsCache {
  readonly invalidated: string[] = [];
  override async loadOrGet(): Promise<Record<string, number>> {
    return {};
  }
  override invalidate(featureId: string): void {
    this.invalidated.push(featureId);
  }
}

describe("assembleForStage — PERF-1: provider-weights cache is not invalidated", () => {
  withDepsRestore(_manifestStoreDeps);

  let origLoadFeatureManifests: typeof _stageAssemblerDeps.loadFeatureManifests;
  let origDeriveProviderWeights: typeof _stageAssemblerDeps.deriveProviderWeights;

  beforeEach(() => {
    origLoadFeatureManifests = _stageAssemblerDeps.loadFeatureManifests;
    origDeriveProviderWeights = _stageAssemblerDeps.deriveProviderWeights;
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async () => {};
  });

  afterEach(() => {
    _stageAssemblerDeps.loadFeatureManifests = origLoadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = origDeriveProviderWeights;
  });

  function makeWeightsCtx(): PipelineContext {
    const config = makeNaxConfig({
      context: { v2: { enabled: true, pluginProviders: [], deterministic: true } },
    });
    return makeTestContext({
      config,
      rootConfig: config,
      prd: makePRD({ feature: "test-feature", userStories: [] }),
      story: makeStory({ id: "US-001" }),
      stories: [],
      routing: { ...DEFAULT_TEST_ROUTING, agent: undefined, testStrategy: "test-after" },
      projectDir: "/repo",
      workdir: "/repo",
      hooks: { hooks: {} },
    });
  }

  test("does not call providerWeightsCache.invalidate after writing a stage manifest", async () => {
    _stageAssemblerDeps.createOrchestrator = () =>
      makeContextOrchestrator({
        assemble: async () =>
          makeContextBundle({
            pushMarkdown: "",
            digest: "abc",
            manifest: {
              requestId: "req-1",
              stage: "execution",
              totalBudgetTokens: 0,
              usedTokens: 0,
              includedChunks: [],
              excludedChunks: [],
              floorItems: [],
              digestTokens: 0,
              buildMs: 0,
            },
          }),
      });
    _stageAssemblerDeps.loadFeatureManifests = (async () => []) as typeof _stageAssemblerDeps.loadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = (() => ({})) as typeof _stageAssemblerDeps.deriveProviderWeights;

    const cache = new SpyProviderWeightsCache();

    const ctx = makeWeightsCtx();
    ctx.providerWeightsCache = cache;

    await assembleForStage(ctx, "execution");

    expect(cache.invalidated).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #662 — extra-provider-ids suite
// ─────────────────────────────────────────────────────────────────────────────

function makeExtraProviderCtx(extraProviderIds?: string[]): PipelineContext {
  const config = makeNaxConfig({
    context: {
      v2: {
        enabled: true,
        minScore: 0.1,
        deterministic: false,
        pluginProviders: [],
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
        stages: extraProviderIds ? { review: { extraProviderIds } } : {},
      },
    },
  });
  const story = makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    projectDir: undefined,
    workdir: "/repo",
  });
}

function makeExtraProviderMockOrchestrator() {
  const captured: { request: ContextRequest | null } = { request: null };
  return {
    captured,
    orchestrator: {
      assemble: async (request: ContextRequest): Promise<ContextBundle> => {
        captured.request = request;
        return makeContextBundle({
          pushMarkdown: "",
          digest: "digest",
          manifest: {
            requestId: "req-1",
            stage: request.stage,
            totalBudgetTokens: request.budgetTokens,
            usedTokens: 0,
            includedChunks: [],
            excludedChunks: [],
            floorItems: [],
            digestTokens: 0,
            buildMs: 0,
          },
        });
      },
    },
  };
}

describe("assembleForStage — issue #662 extraProviderIds", () => {
  test("passes configured extraProviderIds into the ContextRequest", async () => {
    const mock = makeExtraProviderMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeExtraProviderCtx(["my-symbol-graph", "team-rag"]), "review");

    expect(mock.captured.request?.extraProviderIds).toEqual(["my-symbol-graph", "team-rag"]);
  });

  test("defaults extraProviderIds to an empty array when the stage has no override", async () => {
    const mock = makeExtraProviderMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeExtraProviderCtx(), "review");

    expect(mock.captured.request?.extraProviderIds).toEqual([]);
  });

  test("schema accepts extraProviderIds and defaults it to [] per stage", () => {
    const parsed = ContextV2ConfigSchema.parse({
      stages: {
        review: { extraProviderIds: ["my-symbol-graph"] },
        verify: {},
      },
    });

    expect(parsed.stages.review?.extraProviderIds).toEqual(["my-symbol-graph"]);
    expect(parsed.stages.verify?.extraProviderIds).toEqual([]);
  });
});
