/**
 * Unit tests for src/review/prepare-inputs.ts
 *
 * Validates that:
 *  - stat is always collected (both modes)
 *  - skip-on-empty-stat triggers in ref mode
 *  - diff is collected only in embedded mode
 *  - adversarial computeTestInventory runs only in embedded mode
 *  - excludePatterns / testGlobs / refExcludePatterns flow through
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _diffUtilsDeps, prepareAdversarialReviewInput, prepareSemanticReviewInput } from "@/review";
import type { AdversarialReviewConfig, SemanticReviewConfig } from "@/review/types";
import type { ResolvedTestPatterns } from "@/test-runners";

function makeSpawnSequence(outputs: string[]) {
  let i = 0;
  return makeSpawn(() => {
    const out = outputs[i] ?? "";
    i += 1;
    return out;
  }).spawn;
}

const STAT_OUT = " src/foo.ts | 5 +-\n 1 file changed, 5 insertions(+)\n";
const DIFF_OUT = "diff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;\n";

const baseSemanticConfig: SemanticReviewConfig = {
  model: "balanced" as const,
  diffMode: "ref",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
};

const baseAdversarialConfig: AdversarialReviewConfig = {
  model: baseSemanticConfig.model,
  diffMode: baseSemanticConfig.diffMode,
  rules: baseSemanticConfig.rules,
  timeoutMs: baseSemanticConfig.timeoutMs,
  parallel: false,
  maxConcurrentSessions: 2,
};

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsValid: typeof _diffUtilsDeps.isGitRefValid;
let origMergeBase: typeof _diffUtilsDeps.getMergeBase;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsValid = _diffUtilsDeps.isGitRefValid;
  origMergeBase = _diffUtilsDeps.getMergeBase;
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsValid;
  _diffUtilsDeps.getMergeBase = origMergeBase;
});

describe("prepareSemanticReviewInput", () => {
  test("ref mode: collects stat, no diff, returns effectiveRef and excludePatterns", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const result = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: baseSemanticConfig,
    });
    expect(result.effectiveRef).toBe("abc123");
    expect(result.stat).toContain("src/foo.ts");
    expect(result.diff).toBeUndefined();
    expect(result.skipReason).toBeUndefined();
    expect(result.excludePatterns.length).toBeGreaterThan(0);
  });

  test("ref mode: empty stat returns skipReason", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const result = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: baseSemanticConfig,
    });
    expect(result.skipReason).toBe("no changes detected");
    expect(result.stat).toBe("");
  });

  test("embedded mode: collects both stat and diff", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, DIFF_OUT]);
    const result = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: { ...baseSemanticConfig, diffMode: "embedded" },
    });
    expect(result.stat).toContain("src/foo.ts");
    expect(result.diff).toContain("diff --git");
    expect(result.skipReason).toBeUndefined();
  });

  test("no ref + no merge-base fallback returns skipReason", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const result = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: undefined,
      config: DEFAULT_CONFIG,
      semanticConfig: baseSemanticConfig,
    });
    expect(result.skipReason).toBe("no git ref");
    expect(result.effectiveRef).toBeUndefined();
  });
});

describe("prepareAdversarialReviewInput", () => {
  test("ref mode + empty stat: resolveTestFilePatterns is NOT invoked (parity with legacy early-return)", async () => {
    // Only one spawn call should occur (collectDiffStat). If resolveTestFilePatterns
    // runs after the !stat check, additional filesystem scans/spawns would fire.
    const spawnMock = makeSpawnSequence([""]); // empty stat
    _diffUtilsDeps.spawn = spawnMock;
    const result = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: baseAdversarialConfig,
    });
    expect(result.skipReason).toBe("no changes detected");
    // Note: testGlobs / refExcludePatterns aren't read by downstream callers when
    // skipReason is set (both runSemantic/AdversarialReview and plan-inputs.ts
    // early-return on skipReason). These assertions exist purely to prove that
    // resolveTestFilePatterns was NOT invoked — i.e. they're a side-effect proof,
    // not a behavioral contract.
    expect(result.testGlobs).toEqual([]);
    expect(result.refExcludePatterns).toEqual([]);
  });

  test("ref mode: collects stat, no diff, no testInventory; surfaces testGlobs", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const result = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: baseAdversarialConfig,
    });
    expect(result.stat).toContain("src/foo.ts");
    expect(result.diff).toBeUndefined();
    expect(result.testInventory).toBeUndefined();
    expect(result.refExcludePatterns.length).toBeGreaterThan(0);
    // testGlobs surface is non-empty for the default TS config
    expect(Array.isArray(result.testGlobs)).toBe(true);
  });

  test("ref mode: empty stat returns skipReason", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const result = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: baseAdversarialConfig,
    });
    expect(result.skipReason).toBe("no changes detected");
  });

  test("embedded mode: collects stat, diff, and computes testInventory", async () => {
    // sequence: stat, diff, computeTestInventory (--name-only --diff-filter=A)
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, DIFF_OUT, "src/foo.ts\nsrc/foo.test.ts\n"]);
    const result = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: { ...baseAdversarialConfig, diffMode: "embedded" },
    });
    expect(result.stat).toContain("src/foo.ts");
    expect(result.diff).toContain("diff --git");
    expect(result.testInventory).toBeDefined();
    expect(result.testInventory?.addedTestFiles ?? []).toContain("src/foo.test.ts");
  });
});

describe("prepare-inputs honors caller-supplied resolvedTestPatterns", () => {
  const sentinel: ResolvedTestPatterns = {
    globs: ["custom/**/*.test.ts"],
    pathspec: [":(exclude)custom/**/*.test.ts"],
    regex: [/custom\/.*\.test\.ts$/],
    testDirs: ["custom"],
    resolution: "fallback" as const,
  };

  test("semantic: uses caller-supplied resolved patterns instead of re-resolving", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const result = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: baseSemanticConfig,
      resolvedTestPatterns: sentinel,
    });
    // excludePatterns derive from the sentinel pathspec, not DEFAULT_CONFIG's TS defaults
    expect(result.excludePatterns.some((p) => p.includes("custom"))).toBe(true);
  });

  test("adversarial: uses caller-supplied resolved patterns instead of re-resolving", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const result = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: baseAdversarialConfig,
      resolvedTestPatterns: sentinel,
    });
    expect(result.testGlobs).toEqual(["custom/**/*.test.ts"]);
    expect(result.refExcludePatterns.some((p) => p.includes("custom"))).toBe(true);
  });
});
