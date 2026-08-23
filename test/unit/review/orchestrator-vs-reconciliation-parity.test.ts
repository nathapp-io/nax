/**
 * AC#6 — Orchestrator vs Reconciliation parity.
 *
 * The orchestrator path (plan-inputs.ts → callOp(semanticReviewOp)) and the
 * reconciliation path (run-initialization.ts → runReview → runSemantic/AdversarialReview)
 * both prepare review inputs. They must produce equivalent SemanticReviewInput /
 * AdversarialReviewInput shapes for the same git state.
 *
 * This test calls prepareSemanticReviewInput / prepareAdversarialReviewInput with
 * the two shapes and asserts equality on the observable fields (skipReason / stat /
 * diff / excludePatterns / testGlobs / refExcludePatterns / testInventory).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { _diffUtilsDeps } from "@/review";
import { prepareAdversarialReviewInput, prepareSemanticReviewInput } from "@/review";
import type { AdversarialReviewConfig, SemanticReviewConfig } from "@/review/types";
import { makeSpawn } from "@test/helpers";

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

const semanticCfg: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
};
const adversarialCfg: AdversarialReviewConfig = { ...semanticCfg } as AdversarialReviewConfig;

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

describe("orchestrator vs reconciliation parity — semantic", () => {
  test("ref mode with changes: same stat / excludePatterns / effectiveRef / skipReason", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const orchestrator = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });

    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const reconciliation = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      // projectDir undefined (reconciliation shape)
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });

    expect(orchestrator.effectiveRef).toBe(reconciliation.effectiveRef);
    expect(orchestrator.stat).toBe(reconciliation.stat);
    expect(orchestrator.diff).toBe(reconciliation.diff);
    expect(orchestrator.excludePatterns).toEqual(reconciliation.excludePatterns);
    expect(orchestrator.skipReason).toBe(reconciliation.skipReason);
  });

  test("ref mode + no changes: both skip with 'no changes detected'", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const orchestrator = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });

    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const reconciliation = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });

    expect(orchestrator.skipReason).toBe("no changes detected");
    expect(reconciliation.skipReason).toBe("no changes detected");
  });

  test("no git ref: both skip with 'no git ref'", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => false);

    const orchestrator = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: undefined,
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });
    const reconciliation = await prepareSemanticReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: undefined,
      config: DEFAULT_CONFIG,
      semanticConfig: semanticCfg,
    });

    expect(orchestrator.skipReason).toBe("no git ref");
    expect(reconciliation.skipReason).toBe("no git ref");
    expect(orchestrator.effectiveRef).toBeUndefined();
    expect(reconciliation.effectiveRef).toBeUndefined();
  });
});

describe("orchestrator vs reconciliation parity — adversarial", () => {
  test("ref mode with changes: same stat / refExcludePatterns / testGlobs", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const orchestrator = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: adversarialCfg,
    });

    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT]);
    const reconciliation = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: adversarialCfg,
    });

    expect(orchestrator.stat).toBe(reconciliation.stat);
    expect(orchestrator.refExcludePatterns).toEqual(reconciliation.refExcludePatterns);
    expect(orchestrator.testGlobs).toEqual(reconciliation.testGlobs);
    expect(orchestrator.testInventory).toBe(reconciliation.testInventory); // both undefined
    expect(orchestrator.skipReason).toBe(reconciliation.skipReason);
  });

  test("embedded mode: same diff / testInventory shapes", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, DIFF_OUT, "src/foo.ts\nsrc/foo.test.ts\n"]);
    const orchestrator = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: { ...adversarialCfg, diffMode: "embedded" },
    });

    _diffUtilsDeps.spawn = makeSpawnSequence([STAT_OUT, DIFF_OUT, "src/foo.ts\nsrc/foo.test.ts\n"]);
    const reconciliation = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: { ...adversarialCfg, diffMode: "embedded" },
    });

    expect(orchestrator.diff).toBe(reconciliation.diff);
    expect(orchestrator.testInventory?.addedTestFiles).toEqual(reconciliation.testInventory?.addedTestFiles ?? []);
  });

  test("ref mode + no changes: both skip without invoking resolveTestFilePatterns", async () => {
    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const orchestrator = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      projectDir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: adversarialCfg,
    });

    _diffUtilsDeps.spawn = makeSpawnSequence([""]);
    const reconciliation = await prepareAdversarialReviewInput({
      workdir: "/tmp/repo",
      storyId: "S1",
      storyGitRef: "abc123",
      config: DEFAULT_CONFIG,
      adversarialConfig: adversarialCfg,
    });

    expect(orchestrator.skipReason).toBe("no changes detected");
    expect(reconciliation.skipReason).toBe("no changes detected");
    expect(orchestrator.testGlobs).toEqual([]);
    expect(reconciliation.testGlobs).toEqual([]);
  });
});
