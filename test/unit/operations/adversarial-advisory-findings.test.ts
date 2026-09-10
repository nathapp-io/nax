// test/unit/operations/adversarial-advisory-findings.test.ts
import { describe, expect, test } from "bun:test";
import { assertDefined, makeAdversarialReviewConfig, makeStory, makeTestRuntime, opSelector } from "@test/helpers";
import type { Finding, Iteration } from "@/findings";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";

const story = makeStory({ id: "us-001", title: "t", acceptanceCriteria: [] });

function makeVerifyCtx() {
  const view = makeTestRuntime().packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(adversarialReviewOp.config)),
    readFile: async () => null,
    fileExists: async () => false,
  };
}

function iter(
  num: number,
  findings: Array<{ file: string; category: string; message: string; severity: "error" | "warning" | "info" }>,
): Iteration {
  return {
    iterationNum: num,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: findings.map(
      (f): Finding => ({
        source: "adversarial-review",
        severity: f.severity,
        category: f.category,
        file: f.file,
        message: f.message,
      }),
    ),
    outcome: "unchanged",
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
  };
}

describe("adversarial verify() advisoryFindings", () => {
  test("non-blocking findings are surfaced as advisoryFindings, not normalizedFindings", async () => {
    const parsed = {
      passed: true,
      findings: [
        { severity: "warning", category: "input", file: "a.ts", line: 1, issue: "tz bug", suggestion: "fix" },
        { severity: "info", category: "convention", file: "b.ts", line: 2, issue: "inline const", suggestion: "hoist" },
      ],
      normalizedFindings: [],
      acDropped: [],
    };
    const input: AdversarialReviewInput = {
      workdir: process.cwd(),
      story,
      blockingThreshold: "error",
      adversarialConfig: makeAdversarialReviewConfig({ recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 } }),
      mode: "ref",
    };
    const { verify } = adversarialReviewOp;
    if (!verify) throw new Error("adversarialReviewOp.verify is not defined");
    const out = await verify(parsed, input, makeVerifyCtx());
    assertDefined(out, "verify() result");
    expect(out.normalizedFindings).toHaveLength(0); // none are blocking at threshold "error"
    expect(out.advisoryFindings).toHaveLength(2);
    expect(out.advisoryFindings?.map((f) => f.message)).toEqual(["tz bug", "inline const"]);
  });

  // Rectification — adversarial review #1/#2: a sub-threshold finding whose
  // appearances (including the current round) hit maxAdvisoryRounds retires
  // rather than drops. Out-of-scope #10 requires retired findings to "remain
  // reported" via advisoryFindings; before this fix they silently vanished.
  // The mapper rebuilds `meta` from scratch, so the stamp must be applied
  // AFTER mapping (parallels the coverageGap precedent in semantic-review).
  test("retired sub-threshold finding surfaces in advisoryFindings with meta.recurrence stamped", async () => {
    const priorIters = [iter(1, [{ file: "a.ts", category: "input", message: "tz bug", severity: "warning" }])];
    const parsed = {
      passed: true,
      findings: [{ severity: "warning", category: "input", file: "a.ts", line: 1, issue: "tz bug", suggestion: "fix" }],
      normalizedFindings: [],
      acDropped: [],
    };
    const input: AdversarialReviewInput = {
      workdir: process.cwd(),
      story,
      blockingThreshold: "error",
      // maxAdvisoryRounds default is 2 → second sighting retires.
      adversarialConfig: makeAdversarialReviewConfig({ recurrenceDemotion: { enabled: true, maxBlockingRounds: 2 } }),
      priorAdversarialIterations: priorIters,
      mode: "ref",
    };
    const { verify } = adversarialReviewOp;
    if (!verify) throw new Error("adversarialReviewOp.verify is not defined");
    const out = await verify(parsed, input, makeVerifyCtx());
    assertDefined(out, "verify() result");
    expect(out.advisoryFindings).toHaveLength(1);
    const retired = out.advisoryFindings?.[0];
    expect(retired?.message).toBe("tz bug");
    const rec = retired?.meta?.recurrence as
      | { disposition?: string; rounds?: number; wasBlocking?: boolean }
      | undefined;
    expect(rec).toMatchObject({ disposition: "retired", wasBlocking: false });
    expect(typeof rec?.rounds).toBe("number");
  });
});
