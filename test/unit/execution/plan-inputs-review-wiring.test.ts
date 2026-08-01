import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { assemblePlanInputsFromCtx } from "../../../src/execution/plan-inputs";
import type { NaxConfig } from "../../../src/config/schema";
import { _diffUtilsDeps } from "../../../src/review";

// ─── Spawn mock for diff-utils used inside prepare-inputs ──────────────────────

function makeSpawnSequence(outputs: string[]) {
  let i = 0;
  return mock((_opts: unknown) => {
    const out = outputs[i] ?? "";
    i += 1;
    return {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(out));
          c.close();
        },
      }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      kill: () => {},
    };
  }) as unknown as typeof _diffUtilsDeps.spawn;
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

function makeCtx(configOverride: Partial<NaxConfig> = {}) {
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
    workdir: "/tmp/repo",
    routing: { testStrategy: "three-session-tdd", agent: "claude" },
    prompt: "ctx",
    featureContextMarkdown: "feat",
    constitution: { content: "" },
    prd: { feature: "f" },
    projectDir: "/tmp/proj",
  } as any;
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
    const ctx = {
      ...makeCtx(),
      routing: { testStrategy: "test-after", agent: "claude" },
      prompt: "single-session prompt",
    } as any;
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.testWriter).toBeUndefined();
    expect(inputs.implementer?.promptMarkdown).toBe("single-session prompt");
    expect(inputs.verifier).toBeUndefined();
  });

  test("populates rectification when inlineReview && rectification.enabled", async () => {
    const ctx = makeCtx({
      execution: {
        ...DEFAULT_CONFIG.execution,
        inlineReview: true,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: true, maxAttemptsTotal: 2 },
      },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.rectification).toBeDefined();
    expect(inputs.rectification!.maxAttempts).toBe(2);
  });

  test("semantic review input carries stat and effectiveRef in ref mode", async () => {
    const ctx = makeCtx({
      review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
    });
    ctx.storyGitRef = "abc123";
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.semanticReview).toBeDefined();
    expect(inputs.semanticReview!.stat).toContain("src/foo.ts");
    expect(inputs.semanticReview!.storyGitRef).toBe("abc123");
    expect(inputs.semanticReview!.diff).toBeUndefined();
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
    expect(inputs.semanticReview).toBeDefined();
    expect(inputs.semanticReview!._refresh).toBeDefined();
    expect(inputs.semanticReview!._refresh!.storyGitRef).toBe("abc123");
  });

  test("adversarial review input carries stat, testGlobs, refExcludePatterns", async () => {
    const ctx = makeCtx({
      review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["adversarial"] },
    });
    ctx.storyGitRef = "abc123";
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.adversarialReview).toBeDefined();
    expect(inputs.adversarialReview!.stat).toContain("src/foo.ts");
    expect(inputs.adversarialReview!.refExcludePatterns?.length ?? 0).toBeGreaterThan(0);
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

    const ctx = makeCtx({
      execution: {
        ...DEFAULT_CONFIG.execution,
        smartTestRunner: { enabled: true, fallback: "import-grep", testFilePatterns: [SENTINEL_GLOB] },
      },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic", "adversarial"],
        // Clear hardcoded excludePatterns so both helpers derive from resolved patterns.
        semantic: { ...DEFAULT_CONFIG.review.semantic, excludePatterns: undefined },
        adversarial: { ...DEFAULT_CONFIG.review.adversarial, excludePatterns: undefined },
      },
    });
    ctx.storyGitRef = "abc123";
    const inputs = await assemblePlanInputsFromCtx(ctx);

    // Both review slots populated (no skip)
    expect(inputs.semanticReview).toBeDefined();
    expect(inputs.adversarialReview).toBeDefined();

    // Both outputs carry the sentinel — proves resolvedTestPatterns was threaded
    // from the single plan-inputs.ts resolution into both prepare-inputs helpers.
    const semanticExcludes = inputs.semanticReview!.excludePatterns ?? [];
    const adversarialExcludes = inputs.adversarialReview!.refExcludePatterns ?? [];
    expect(semanticExcludes).toContain(SENTINEL_PATHSPEC);
    expect(semanticExcludes).toContain(SENTINEL_DIR_PATHSPEC);
    expect(adversarialExcludes).toContain(SENTINEL_PATHSPEC);
    expect(adversarialExcludes).toContain(SENTINEL_DIR_PATHSPEC);
  });
});

