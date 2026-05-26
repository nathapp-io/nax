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

  test("semantic review slot is omitted when no changes detected", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([""]); // empty stat
    const ctx = makeCtx({
      review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
    });
    ctx.storyGitRef = "abc123";
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.semanticReview).toBeUndefined();
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

  test("priorSemanticIterations on ctx threads into semantic input", async () => {
    const ctx = makeCtx({
      review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["semantic"] },
    });
    ctx.storyGitRef = "abc123";
    const priorIter = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [],
      outcome: "unchanged" as const,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
    };
    ctx.priorSemanticIterations = [priorIter];
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.semanticReview!.priorSemanticIterations).toEqual([priorIter]);
  });
});
