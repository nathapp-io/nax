import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeDispatchContext, makePRD, makeSpawn } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { NaxConfig } from "@/config/schema";
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

describe("assemblePlanInputsFromCtx — review + rectification wiring", () => {
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

describe("assemblePlanInputsFromCtx — evidence substantiation wiring (#1668)", () => {
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
