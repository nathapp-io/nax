/**
 * Unit tests for src/context/engine/stage-assembler.ts — disk-backed session
 * scratch discovery (Finding 2 from the Context Engine v2 architecture review)
 * and AC-24/AC-51 ContextRequest propagation (#504).
 *
 * Tests call `discoverSessionScratchDirsOnDisk` directly so the return value
 * is observable. The helper is exported from stage-assembler for this purpose.
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
import {
  _stageAssemblerDeps,
  assembleForStage,
  discoverSessionScratchDirsOnDisk,
} from "@/context/engine/stage-assembler";
import type { ContextBundle, ContextRequest } from "@/context/engine/types";
import type { PipelineContext, RoutingResult } from "@/pipeline/types";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";
import type { NaxIgnoreIndex } from "@/utils/path-filters";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = Date.parse("2026-04-17T12:00:00.000Z");
const WITHIN_TTL_ISO = "2026-04-17T10:00:00.000Z"; // 2h ago
const OUTSIDE_TTL_ISO = "2026-04-17T00:00:00.000Z"; // 12h ago
const TTL_4H = 4 * 60 * 60 * 1000;

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY = "US-001";
const SESSIONS_ROOT = `${PROJECT_DIR}/.nax/features/${FEATURE}/sessions`;

// ─────────────────────────────────────────────────────────────────────────────

describe("discoverSessionScratchDirsOnDisk — Finding 2", () => {
  let originalReaddir: typeof _stageAssemblerDeps.readdir;
  let originalReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let originalNow: typeof _stageAssemblerDeps.now;

  beforeEach(() => {
    originalReaddir = _stageAssemblerDeps.readdir;
    originalReadDescriptor = _stageAssemblerDeps.readDescriptor;
    originalNow = _stageAssemblerDeps.now;
    _stageAssemblerDeps.now = () => FIXED_NOW;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = originalReaddir;
    _stageAssemblerDeps.readDescriptor = originalReadDescriptor;
    _stageAssemblerDeps.now = originalNow;
  });

  test("returns scratch dirs for all descriptors matching storyId and within TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-a", "sess-b"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-a")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-a`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      if (path.includes("sess-b")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-b`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      return null;
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toHaveLength(2);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-a`);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-b`);
  });

  test("resolves relative scratchDir from descriptor to absolute project path", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-rel"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: STORY,
      scratchDir: ".nax/features/test-feature/sessions/sess-rel",
      lastActivityAt: WITHIN_TTL_ISO,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-rel`]);
  });

  test("resolves dot scratchDir from descriptor to project root", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-dot"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: STORY,
      scratchDir: ".",
      lastActivityAt: WITHIN_TTL_ISO,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([PROJECT_DIR]);
  });

  test("skips descriptors for a different story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-mine", "sess-theirs"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-mine")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-mine`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: "US-002", scratchDir: `${SESSIONS_ROOT}/sess-theirs`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-mine`]);
  });

  test("skips descriptors older than TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-fresh", "sess-stale"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-fresh")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-fresh`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-stale`, lastActivityAt: OUTSIDE_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-fresh`]);
  });

  test("returns empty when the sessions directory does not exist", async () => {
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    _stageAssemblerDeps.readDescriptor = async () => {
      throw new Error("should not be called");
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("skips malformed descriptors without throwing", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-broken", "sess-good"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-broken")) throw new Error("unexpected token in JSON");
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-good`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-good`]);
  });

  test("skips descriptors missing scratchDir", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-partial", "sess-full"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-partial")) return { storyId: STORY, lastActivityAt: WITHIN_TTL_ISO };
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-full`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-full`]);
  });

  test("skips descriptors with unparseable lastActivityAt", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-baddate", "sess-gooddate"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-baddate")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-baddate`, lastActivityAt: "not-a-date" };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-gooddate`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-gooddate`]);
  });

  test("skips descriptors missing lastActivityAt entirely", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-nodate"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: STORY,
      scratchDir: `${SESSIONS_ROOT}/sess-nodate`,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("reads descriptors under the correct sessions path", async () => {
    const calls: string[] = [];
    _stageAssemblerDeps.readdir = async (path: string) => {
      calls.push(`readdir:${path}`);
      return ["sess-a"];
    };
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      calls.push(`readDescriptor:${path}`);
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-a`, lastActivityAt: WITHIN_TTL_ISO };
    };

    await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(calls[0]).toBe(`readdir:${SESSIONS_ROOT}`);
    expect(calls[1]).toBe(`readDescriptor:${SESSIONS_ROOT}/sess-a/descriptor.json`);
  });

  test("returns empty when no descriptors match the story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-other"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: "US-999",
      scratchDir: `${SESSIONS_ROOT}/sess-other`,
      lastActivityAt: WITHIN_TTL_ISO,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-24 / AC-51 — deterministic + planDigestBoost propagation (#504)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal PipelineContext for assembleForStage tests */
function makeCtx(
  overrides: {
    deterministic?: boolean;
    testStrategy?: RoutingResult["testStrategy"];
    /** Override the agent-spawn workdir (ctx.workdir). Defaults to "/repo". */
    workdir?: string;
    /** Override the repo root (ctx.projectDir). Defaults to undefined to suppress manifest writes. */
    projectDir?: string;
    /** Override story.workdir (relative sub-package path). */
    storyWorkdir?: string;
    /** ADR-009 resolved test-file patterns carried on the pipeline context. */
    resolvedTestPatterns?: ResolvedTestPatterns;
    /** Pre-built .naxignore index carried on the pipeline context. */
    naxIgnoreIndex?: NaxIgnoreIndex;
    /** Per-stage v2 overrides (config.context.v2.stages). */
    stages?: Record<string, { budgetTokens?: number; extraProviderIds?: string[]; providerTimeoutMs?: number }>;
  } = {},
): PipelineContext {
  const config = makeNaxConfig({
    context: {
      v2: {
        enabled: true,
        pluginProviders: [],
        deterministic: overrides.deterministic,
        ...(overrides.stages && { stages: overrides.stages }),
      },
    },
  });
  const story = makeStory({
    id: "US-001",
    ...(overrides.storyWorkdir && { workdir: overrides.storyWorkdir }),
  });
  return makeTestContext({
    config,
    ...(overrides.resolvedTestPatterns !== undefined && { resolvedTestPatterns: overrides.resolvedTestPatterns }),
    ...(overrides.naxIgnoreIndex !== undefined && { naxIgnoreIndex: overrides.naxIgnoreIndex }),
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    routing: { ...DEFAULT_TEST_ROUTING, agent: undefined, testStrategy: overrides.testStrategy ?? "test-after" },
    projectDir: overrides.projectDir, // undefined by default — prevents manifest writing in tests
    workdir: overrides.workdir ?? "/repo",
    hooks: { hooks: {} },
  });
}

/** Mock orchestrator that captures the last assemble() request via a mutable ref. */
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

describe("assembleForStage — AC-24/AC-51 ContextRequest propagation", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    // Suppress disk discovery
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

  test("AC-24: passes deterministic:true when config flag is set", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ deterministic: true }), "execution");

    expect(mock.ref.captured?.deterministic).toBe(true);
  });

  test("AC-24: passes deterministic:false when config flag is unset", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ deterministic: false }), "execution");

    expect(mock.ref.captured?.deterministic).toBe(false);
  });

  test("AC-51: passes planDigestBoost from routing testStrategy (tdd-simple → 1.5)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "tdd-simple" }), "execution");

    expect(mock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("AC-51: planDigestBoost is undefined for three-session-tdd (uses multi-session digest)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "three-session-tdd" }), "tdd-implementer");

    expect(mock.ref.captured?.planDigestBoost).toBeUndefined();
  });

  test("AC-51: planDigestBoost 1.5 for no-test strategy", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "no-test" }), "execution");

    expect(mock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("threads availableBudgetTokens from stage assembly call site", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "tdd-simple" }), "execution");

    expect(mock.ref.captured?.availableBudgetTokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 6 — resolvedTestPatterns / naxIgnoreIndex never reached
// assembleForStage, so every stage it serves (tdd-test-writer, tdd-implementer,
// rectify, single-session, batch) lost sibling-test hinting and .naxignore
// filtering. The context stage set resolvedTestPatterns; nothing else did.
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — ADR-009 / .naxignore threading", () => {
  const origCreate = _stageAssemblerDeps.createOrchestrator;
  afterEach(() => {
    _stageAssemblerDeps.createOrchestrator = origCreate;
  });

  test("threads the engine-wide providerTimeoutMs from config into the request", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const ctx = makeCtx();
    ctx.config.context.v2.providerTimeoutMs = 9000;
    await assembleForStage(ctx, "execution");

    expect(mock.ref.captured?.providerTimeoutMs).toBe(9000);
  });

  test("a per-stage providerTimeoutMs override wins over the engine-wide value", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const ctx = makeCtx({ stages: { execution: { providerTimeoutMs: 2000 } } });
    ctx.config.context.v2.providerTimeoutMs = 9000;
    await assembleForStage(ctx, "execution");

    expect(mock.ref.captured?.providerTimeoutMs).toBe(2000);
  });

  test("threads resolvedTestPatterns from the pipeline context into the request", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    const patterns = {
      regex: [/\.test\.ts$/],
      globs: ["test/**/*.test.ts"],
      testDirs: ["test"],
      pathspec: [],
      resolution: "detected" as const,
    };

    await assembleForStage(makeCtx({ resolvedTestPatterns: patterns }), "tdd-test-writer");

    expect(mock.ref.captured?.resolvedTestPatterns).toBe(patterns);
  });

  test("threads naxIgnoreIndex from the pipeline context into the request", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    const index = {
      repoRoot: "/repo",
      getMatchers: () => [],
      filter: (paths: readonly string[]) => [...paths],
      toPathspecExcludes: () => [],
    };

    await assembleForStage(makeCtx({ naxIgnoreIndex: index }), "tdd-implementer");

    expect(mock.ref.captured?.naxIgnoreIndex).toBe(index);
  });

  test("leaves both undefined when the pipeline context carries neither", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx(), "execution");

    expect(mock.ref.captured?.resolvedTestPatterns).toBeUndefined();
    expect(mock.ref.captured?.naxIgnoreIndex).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #556 — monorepo ctx.workdir contamination regression
//
// iteration-runner.ts resolves ctx.workdir to join(repoRoot, story.workdir).
// assembleForStage must NOT re-join story.workdir onto ctx.workdir — doing so
// doubles the sub-package path (e.g. /repo/packages/lib/packages/lib).
// repoRoot in the ContextRequest must come from ctx.projectDir.
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — Issue #556 monorepo workdir contamination", () => {
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

  test("repoRoot is ctx.projectDir and packageDir is ctx.workdir in monorepo mode", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    // Simulate what iteration-runner.ts sets on PipelineContext for a monorepo story:
    //   projectDir = repo root (stable), workdir = join(repoRoot, story.workdir)
    await assembleForStage(
      makeCtx({
        projectDir: "/repo",
        workdir: "/repo/packages/lib",
        storyWorkdir: "packages/lib",
      }),
      "execution",
    );

    expect(mock.ref.captured?.repoRoot).toBe("/repo");
    expect(mock.ref.captured?.packageDir).toBe("/repo/packages/lib");
  });

  test("repoRoot and packageDir are equal for single-package repos", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    // Single-package: iteration-runner sets workdir === projectDir, story.workdir unset
    await assembleForStage(
      makeCtx({
        projectDir: "/repo",
        workdir: "/repo",
      }),
      "execution",
    );

    expect(mock.ref.captured?.repoRoot).toBe("/repo");
    expect(mock.ref.captured?.packageDir).toBe("/repo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax-finish escalation finding (effectiveness-scoring-loop, HIGH) — the context
// stage's own ContextRequest is not the only one scored. assembleForStage()
// builds a fresh request per non-three-session-tdd stage (execution, rectify,
// tdd-*, review-*), and until this fix it never derived providerWeights, so the
// learned effectiveness multiplier never reached the bundle that actually
// becomes the agent's prompt.
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — provider-weights threading (effectiveness-scoring-loop)", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;
  let origLoadFeatureManifests: typeof _stageAssemblerDeps.loadFeatureManifests;
  let origDeriveProviderWeights: typeof _stageAssemblerDeps.deriveProviderWeights;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    origLoadFeatureManifests = _stageAssemblerDeps.loadFeatureManifests;
    origDeriveProviderWeights = _stageAssemblerDeps.deriveProviderWeights;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
    _stageAssemblerDeps.loadFeatureManifests = origLoadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = origDeriveProviderWeights;
  });

  test("threads deriveProviderWeights' result into the request as providerWeights", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    _stageAssemblerDeps.loadFeatureManifests = (async () => []) as typeof _stageAssemblerDeps.loadFeatureManifests;
    const weights = { "static-rules": 1.0, "code-neighbor": 0.4 };
    _stageAssemblerDeps.deriveProviderWeights = (() => weights) as typeof _stageAssemblerDeps.deriveProviderWeights;

    await assembleForStage(makeCtx(), "execution");

    expect(mock.ref.captured?.providerWeights).toEqual(weights);
  });

  test("calls loadFeatureManifests with the request's featureId and projectDir", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    let capturedArgs: { featureId?: string; projectDir?: string } = {};
    _stageAssemblerDeps.loadFeatureManifests = (async (opts?: { featureId?: string; projectDir?: string }) => {
      capturedArgs = { featureId: opts?.featureId, projectDir: opts?.projectDir };
      return [];
    }) as typeof _stageAssemblerDeps.loadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = (() => ({})) as typeof _stageAssemblerDeps.deriveProviderWeights;

    await assembleForStage(makeCtx(), "execution");

    expect(capturedArgs.featureId).toBe("test-feature");
    expect(capturedArgs.projectDir).toBe("/repo");
  });

  test("falls back to the '_unattached' sentinel when the pipeline context has no feature id", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    let capturedFeatureId: string | undefined;
    _stageAssemblerDeps.loadFeatureManifests = (async (opts?: { featureId?: string }) => {
      capturedFeatureId = opts?.featureId;
      return [];
    }) as typeof _stageAssemblerDeps.loadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = (() => ({})) as typeof _stageAssemblerDeps.deriveProviderWeights;

    const ctx = makeCtx();
    // `PRD.feature` is required, so reaching the `_unattached` fallback needs a
    // widened alias rather than a cast: `PRD` is structurally assignable to a
    // weak `{ feature?: string }`, and the alias is the same object.
    const widened: { feature?: string } = ctx.prd;
    widened.feature = undefined;

    await assembleForStage(ctx, "execution");

    expect(capturedFeatureId).toBe("_unattached");
  });

  test("degrades to no providerWeights when deriveProviderWeights throws", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
    _stageAssemblerDeps.loadFeatureManifests = (async () => []) as typeof _stageAssemblerDeps.loadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = (() => {
      throw new Error("boom");
    }) as typeof _stageAssemblerDeps.deriveProviderWeights;

    const bundle = await assembleForStage(makeCtx(), "execution");

    expect(bundle).not.toBeNull();
    expect(mock.ref.captured?.providerWeights).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: assembleForStage publishes the full storyScratchDirs so the pull-tool
// runtime (query_scratch) can read the same dirs the push providers read, rather
// than only ctx.sessionScratchDir.
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — publishes storyScratchDirs (US-005)", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    // Suppress disk discovery
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

  test("publishes the resolved storyScratchDirs onto the pipeline context and the request", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const ctx = makeCtx();
    ctx.sessionScratchDir = "/tmp/nax-sessions/sess-1";

    await assembleForStage(ctx, "execution");

    // The pull runtime reads this published list so it sees the same dirs as
    // the push providers, not just the single sessionScratchDir.
    expect(ctx.storyScratchDirs).toEqual(["/tmp/nax-sessions/sess-1"]);
    // The push providers receive the same dirs via the assembled request.
    expect(mock.ref.captured?.storyScratchDirs).toEqual(["/tmp/nax-sessions/sess-1"]);
  });
});
