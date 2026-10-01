import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  assertNaxError,
  makeDispatchContext,
  makeNaxConfig,
  makePRD,
  makeSparseNaxConfig,
  makeSpawn,
  makeStory,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { NaxConfig } from "@/config/schema";
import { NaxError } from "@/errors";
import { assemblePlanInputs } from "@/execution";
import { assemblePlanInputsFromCtx } from "@/execution/plan-inputs";
import type { PipelineContext } from "@/pipeline/types";
import { _diffUtilsDeps } from "@/review";

// ─── Spawn mock for diff-utils used inside prepare-inputs ──────────────────────

// Clears the hardcoded default excludePatterns so review inputs derive them from
// testFilePatterns instead (ADR-009 §4.4). `excludePatterns: undefined` is the
// documented "derive" state, but spreading the interface-typed DEFAULT_CONFIG
// sub-object drops required-field requiredness, so strip the key instead.
function withoutExcludePatterns<C extends { excludePatterns?: string[] }>(c: C): Omit<C, "excludePatterns"> {
  const { excludePatterns: _exclude, ...rest } = c;
  return rest;
}

function makeSpawnSequence(outputs: string[]) {
  let i = 0;
  return makeSpawn(() => {
    const out = outputs[i] ?? "";
    i += 1;
    return out;
  }).spawn;
}

const STAT_OUT = " src/foo.ts | 5 +-\n 1 file changed, 5 insertions(+)\n";

function makeCtx(configOverride: Partial<NaxConfig> = {}): PipelineContext {
  const config: NaxConfig = {
    ...DEFAULT_CONFIG,
    ...configOverride,
    execution: {
      ...DEFAULT_CONFIG.execution,
      ...(configOverride.execution ?? {}),
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...(configOverride.review ?? {}),
    },
  } as NaxConfig;
  return {
    story: {
      id: "S1",
      title: "T",
      description: "story",
      acceptanceCriteria: ["ac"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      workdir: "",
    },
    config,
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/repo",
    routing: {
      complexity: "simple",
      modelTier: "balanced",
      testStrategy: "three-session-tdd",
      reasoning: "",
      agent: "claude",
    },
    prompt: "ctx",
    featureContextMarkdown: "feat",
    constitution: { content: "", tokens: 0, truncated: false },
    prd: makePRD({ feature: "f", userStories: [] }),
    projectDir: "/tmp/proj",
    hooks: { hooks: {} },
    stories: [],
    ...makeDispatchContext(),
  };
}

// The diff-utils save/restore hook pair is scoped to this wrapping describe so
// it does not leak into the `assemblePlanInputs` (non-ctx) validation tests
// below, which never touch `_diffUtilsDeps` (§1.6).
describe("assemblePlanInputsFromCtx — review wiring", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsValid: typeof _diffUtilsDeps.isGitRefValid;
  let origMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsValid = _diffUtilsDeps.isGitRefValid;
    origMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    // Default: stat returns something so review slot populates.
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, STAT_OUT]);
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsValid;
    _diffUtilsDeps.getMergeBase = origMergeBase;
  });

  describe("review + rectification wiring", () => {
    test("prebuilds three-session prompts for test-writer, implementer, and verifier", async () => {
      const ctx = makeCtx();
      const inputs = await assemblePlanInputsFromCtx(ctx);
      expect(inputs.testWriter?.promptMarkdown).toContain("# Role: Test-Writer");
      expect(inputs.implementer?.promptMarkdown).toContain("# Role: Implementer");
      expect(inputs.verifier?.promptMarkdown).toContain("# Role: Verifier");
    });

    test("uses the existing single-session prompt for non-TDD implementer plans", async () => {
      const ctx: PipelineContext = {
        ...makeCtx(),
        routing: {
          complexity: "simple",
          modelTier: "balanced",
          testStrategy: "test-after",
          reasoning: "",
          agent: "claude",
        },
        prompt: "single-session prompt",
      };
      const inputs = await assemblePlanInputsFromCtx(ctx);
      expect(inputs.testWriter).toBeUndefined();
      expect(inputs.implementer?.promptMarkdown).toBe("single-session prompt");
      expect(inputs.verifier).toBeUndefined();
    });

    test("populates rectification when inlineReview && rectification.enabled", async () => {
      const ctx = makeCtx({
        execution: {
          ...DEFAULT_CONFIG.execution,
          rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: true, maxAttemptsTotal: 2 },
        },
        review: {
          ...DEFAULT_CONFIG.review,
          enabled: true,
          checks: ["semantic"],
        },
      });
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.rectification, "inputs.rectification");
      expect(inputs.rectification.maxAttempts).toBe(2);
    });

    test("semantic review input carries stat and effectiveRef in ref mode", async () => {
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.semanticReview, "inputs.semanticReview");
      expect(inputs.semanticReview.stat).toContain("src/foo.ts");
      expect(inputs.semanticReview.storyGitRef).toBe("abc123");
      expect(inputs.semanticReview.diff).toBeUndefined();
    });

    test("semantic review slot is registered with _refresh payload even when plan-build diff is empty", async () => {
      // Bug A regression: plan-build runs BEFORE test-writer/implementer, so the diff
      // is naturally empty at this moment. Previously the slot was dropped permanently;
      // now it stays registered and carries `_refresh` so the orchestrator re-prepares
      // stat/diff at dispatch time (after the story has produced real changes).
      _diffUtilsDeps.spawn = makeSpawnSequence([""]); // empty stat at plan-build
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.semanticReview, "inputs.semanticReview");
      assertDefined(inputs.semanticReview._refresh, "inputs.semanticReview._refresh");
      expect(inputs.semanticReview._refresh.storyGitRef).toBe("abc123");
    });

    test("adversarial review input carries stat, testGlobs, refExcludePatterns", async () => {
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["adversarial"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.adversarialReview, "inputs.adversarialReview");
      expect(inputs.adversarialReview.stat).toContain("src/foo.ts");
      expect(inputs.adversarialReview.refExcludePatterns?.length ?? 0).toBeGreaterThan(0);
    });

    test("AC#4 (#1120): resolveTestFilePatterns result is shared between semantic and adversarial helpers via resolvedTestPatterns", async () => {
      // Both checks enabled — two prepare-inputs calls. plan-inputs.ts resolves patterns
      // once and forwards resolvedTestPatterns to both helpers, preventing double resolution.
      // This test injects a sentinel via config.testFilePatterns and verifies it surfaces
      // consistently in BOTH review inputs — proving the shared resolution was threaded through.
      _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, STAT_OUT]);

      // Sentinel pattern that won't appear in WELL_KNOWN_TEST_DIRS / WELL_KNOWN_TEST_SUFFIXES,
      // so its presence in excludePatterns can only come from the config-driven resolution.
      const SENTINEL_GLOB = "custom-e2e/**/*.e2etest.ts";
      const SENTINEL_PATHSPEC = ":!*.e2etest.ts";
      const SENTINEL_DIR_PATHSPEC = ":!custom-e2e/";

      const defaultSemantic = DEFAULT_CONFIG.review.semantic;
      assertDefined(defaultSemantic, "DEFAULT_CONFIG.review.semantic");
      const defaultAdversarial = DEFAULT_CONFIG.review.adversarial;
      assertDefined(defaultAdversarial, "DEFAULT_CONFIG.review.adversarial");

      const ctx = makeCtx({
        execution: {
          ...DEFAULT_CONFIG.execution,
          smartTestRunner: {
            enabled: true,
            fallback: "import-grep",
            maxScanFiles: 200,
            testFilePatterns: [SENTINEL_GLOB],
          },
        },
        review: {
          ...DEFAULT_CONFIG.review,
          enabled: true,
          checks: ["semantic", "adversarial"],
          // Clear hardcoded excludePatterns so both helpers derive from resolved patterns.
          semantic: withoutExcludePatterns(defaultSemantic),
          adversarial: withoutExcludePatterns(defaultAdversarial),
        },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);

      // Both review slots populated (no skip)
      assertDefined(inputs.semanticReview, "inputs.semanticReview");
      assertDefined(inputs.adversarialReview, "inputs.adversarialReview");

      // Both outputs carry the sentinel — proves resolvedTestPatterns was threaded
      // from the single plan-inputs.ts resolution into both prepare-inputs helpers.
      const semanticExcludes = inputs.semanticReview.excludePatterns ?? [];
      const adversarialExcludes = inputs.adversarialReview.refExcludePatterns ?? [];
      expect(semanticExcludes).toContain(SENTINEL_PATHSPEC);
      expect(semanticExcludes).toContain(SENTINEL_DIR_PATHSPEC);
      expect(adversarialExcludes).toContain(SENTINEL_PATHSPEC);
      expect(adversarialExcludes).toContain(SENTINEL_DIR_PATHSPEC);
    });
  });

  describe("evidence substantiation wiring (#1668)", () => {
    // `checkFindingEvidence` resolves a finding's file against `repoRoot` first,
    // falling back to `workdir` as a package-relative path. Review findings carry
    // repo-root-relative paths (git emits them that way), so in a monorepo — where
    // `workdir` is the package dir, not the repo root — omitting `repoRoot` makes
    // every lookup double-count the package prefix, return "unreadable", and
    // fail open. Substantiation was inert for every monorepo package story.
    test("semantic review input carries repoRoot so evidence resolves against the repo root", async () => {
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.semanticReview, "inputs.semanticReview");
      expect(inputs.semanticReview.repoRoot).toBe("/tmp/proj");
    });

    test("adversarial review input carries repoRoot so evidence resolves against the repo root", async () => {
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["adversarial"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.adversarialReview, "inputs.adversarialReview");
      expect(inputs.adversarialReview.repoRoot).toBe("/tmp/proj");
    });

    test("repoRoot is distinct from workdir, so the package prefix is not double-counted", async () => {
      // Guards the regression directly: if repoRoot were sourced from ctx.workdir
      // (the package dir) the fallback would resolve <pkg>/<pkg>/<file>.
      const ctx = makeCtx({
        review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic", "adversarial"] },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      assertDefined(inputs.semanticReview, "inputs.semanticReview");
      assertDefined(inputs.adversarialReview, "inputs.adversarialReview");
      expect(inputs.semanticReview.repoRoot).toBeDefined();
      expect(inputs.adversarialReview.repoRoot).toBeDefined();
      expect(inputs.semanticReview.repoRoot).not.toBe(inputs.semanticReview.workdir);
      expect(inputs.adversarialReview.repoRoot).not.toBe(inputs.adversarialReview.workdir);
    });
  });
});

describe("assemblePlanInputs — test patterns validation (AC3)", () => {
  test("succeeds when resolvedTestPatterns is undefined (not needed)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config, undefined);
    expect(result).toBeDefined();
    expect(result.resolvedTestPatterns).toBeUndefined();
  });

  test("succeeds when resolvedTestPatterns is omitted", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
    expect(result.resolvedTestPatterns).toBeUndefined();
  });

  test("throws NaxError when resolvedTestPatterns is explicitly null", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config, null);
    }).toThrow(NaxError);
  });

  test("error code is TEST_PATTERNS_MISSING for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("TEST_PATTERNS_MISSING");
    }
  });

  test("error context.stage is 'execution-inputs' for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.stage).toBe("execution-inputs");
    }
  });

  test("error context includes storyId for correlation", () => {
    const story = makeStory({ id: "US-042", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.storyId).toBe("US-042");
    }
  });

  test("error context.field is 'resolvedTestPatterns' for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.field).toBe("resolvedTestPatterns");
    }
  });

  test("error message is human-readable and references test patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      const msg = err.message.toLowerCase();
      expect(msg).toContain("test");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("error code is UPPER_SNAKE_CASE (machine-parseable)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(/^[A-Z_]+$/.test(err.code)).toBe(true);
    }
  });

  test("story.id check fires before test-patterns check (story guard takes priority)", () => {
    const story = makeStory({ id: "" }); // Invalid story
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      // Story validation fires first
      expect(err.code).toBe("STORY_ID_INVALID");
    }
  });

  test("config guard fires before test-patterns check", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      // Config validation fires before test patterns
      expect(err.code).toBe("CONFIG_INVALID");
    }
  });

  test("includes resolvedTestPatterns in returned PlanInputs when provided", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();
    const fakePatterns = {
      globs: ["**/*.test.ts"],
      pathspec: [":!*.test.ts"],
      regex: [/\.test\.ts$/],
      testDirs: ["test"],
      resolution: "fallback" as const,
    };

    const result = assemblePlanInputs(story, config, fakePatterns);
    expect(result.resolvedTestPatterns).toBe(fakePatterns);
  });
});

describe("assemblePlanInputs — model tier mapping validation", () => {
  test("passes when default agent has tier mappings in config.models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
    });

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
  });

  test("throws CONFIG_INVALID when config.models is empty (no mappings for any agent)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error code is CONFIG_INVALID for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("CONFIG_INVALID");
    }
  });

  test("error context.field is 'models' for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.field).toBe("models");
    }
  });

  test("error context.stage is 'execution-inputs' for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.stage).toBe("execution-inputs");
    }
  });

  test("throws CONFIG_INVALID when default agent has no entry in models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // sparse config: agent.default set, models omitted entirely
    const config = makeSparseNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
      models: {},
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("throws CONFIG_INVALID when agent.default names an agent absent from models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // sparse config: models only contains "other-agent", not the default "claude"
    const config = makeSparseNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
      models: { "other-agent": { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error message references tier mapping requirement", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.message.toLowerCase()).toContain("model");
    }
  });

  test("error includes storyId for correlation", () => {
    const story = makeStory({ id: "US-042", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      expect(err.context?.storyId).toBe("US-042");
    }
  });

  test("agent.default check fires before models check (agent error takes priority)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // Both invalid: empty agent.default and empty models
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
      models: {},
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      assertNaxError(err);
      // The agent.default guard fires first; field should be "agent.default"
      expect(err.context?.field).toBe("agent.default");
    }
  });
});
