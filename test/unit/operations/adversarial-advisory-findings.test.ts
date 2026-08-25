// test/unit/operations/adversarial-advisory-findings.test.ts
import { describe, expect, test } from "bun:test";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";
import { makeAdversarialReviewConfig, makeStory } from "@test/helpers";

const story = makeStory({ id: "us-001", title: "t", acceptanceCriteria: [] });

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
    const out = await (adversarialReviewOp as any).verify(parsed, input, {});
    expect(out.normalizedFindings).toHaveLength(0); // none are blocking at threshold "error"
    expect(out.advisoryFindings).toHaveLength(2);
    expect(out.advisoryFindings.map((f: { message: string }) => f.message)).toEqual(["tz bug", "inline const"]);
  });
});
