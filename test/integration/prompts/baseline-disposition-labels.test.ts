/**
 * US-003 integration — labels flow from a seeded baseline artifact through the
 * full-suite gate to both rectification prompt surfaces.
 *
 * The unit tests pin each end in isolation (gate classification in
 * `full-suite-gate.test.ts`, tag rendering in the rectifier-builder tests).
 * This test pins the seam between them: a seeded story baseline artifact labels
 * the gate's findings, and those same findings render their tags in the
 * failing-test list and in the prioritized-failure list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeStory, makeTempDir } from "@test/helpers";
import type { FullSuiteGateDeps, FullSuiteGateInput } from "@/operations";
import { fullSuiteGateOp } from "@/operations";
import { RectifierPromptBuilder } from "@/prompts";
import type { ReviewCheckResult } from "@/review";
import { writeStoryBaseline } from "@/verification";

const FEATURE_ID = "feature-labels";
const STORY_ID = "US-001";

let tempRoot: string;

beforeEach(() => {
  tempRoot = makeTempDir("nax-test-baseline-labels-");
});

afterEach(() => {
  cleanupTempDir(tempRoot);
});

/** A stubbed suite run: `test A` is in the seeded baseline, `test B` is not. */
function gateDeps(): FullSuiteGateDeps {
  return {
    resolveGateContext: async () => ({
      config: makeNaxConfig(),
      testCmd: "bun test",
      fullSuiteTimeout: 60,
      cmdWorkdir: tempRoot,
    }),
    runTests: async () => ({
      passed: false,
      failed: 2,
      output: "2 tests failed",
      parsedSummary: {
        passed: 0,
        failed: 2,
        failures: [
          { file: "test/unit/a.test.ts", testName: "test A", error: "err A", stackTrace: [] },
          { file: "test/unit/b.test.ts", testName: "test B", error: "err B", stackTrace: [] },
        ],
      },
      timedOut: false,
    }),
  };
}

describe("baseline disposition labels — gate to prompt", () => {
  test("both rectification prompt surfaces render the gate's baseline labels", async () => {
    const story = makeStory({ id: STORY_ID });
    await writeStoryBaseline(tempRoot, FEATURE_ID, STORY_ID, {
      kind: "captured",
      source: "roll-forward",
      capturedAt: "2026-01-15T01:00:00.000Z",
      entries: [{ file: "test/unit/a.test.ts", testName: "test A" }],
    });

    const input: FullSuiteGateInput = { story, workdir: tempRoot, projectDir: tempRoot, featureName: FEATURE_ID };
    const out = await fullSuiteGateOp.execute(input, makeMockCallContext(), gateDeps());

    expect(out.status).toBe("failed");
    expect(out.findings.map((f) => f.baselineDisposition)).toEqual(["pre-existing", "introduced"]);

    // Surface 1 — the failing-test list.
    const failingTestPrompt = RectifierPromptBuilder.failingTestRectification(out.findings, story);
    expect(failingTestPrompt).toContain("- test/unit/a.test.ts [pre-existing at baseRef]");
    expect(failingTestPrompt).toContain("- test/unit/b.test.ts [introduced by your changes]");

    // Surface 2 — the prioritized-failure render.
    const check: ReviewCheckResult = {
      check: "test",
      success: false,
      command: "bun test",
      exitCode: 1,
      output: "2 tests failed",
      durationMs: 10,
      findings: out.findings,
    };
    const prioritizedPrompt = RectifierPromptBuilder.firstAttemptDelta([check], 2);
    expect(prioritizedPrompt).toContain("[pre-existing at baseRef]");
    expect(prioritizedPrompt).toContain("[introduced by your changes]");
  });
});
