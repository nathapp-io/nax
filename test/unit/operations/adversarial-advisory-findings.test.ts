// test/unit/operations/adversarial-advisory-findings.test.ts
import { describe, expect, test } from "bun:test";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";

const story = { id: "us-001", title: "t", acceptanceCriteria: [] } as unknown as AdversarialReviewInput["story"];

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
    const input = {
      workdir: process.cwd(),
      story,
      blockingThreshold: "error",
      adversarialConfig: { recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 } },
    } as unknown as AdversarialReviewInput;
    const out = await (adversarialReviewOp as any).verify(parsed, input, {});
    expect(out.normalizedFindings).toHaveLength(0); // none are blocking at threshold "error"
    expect(out.advisoryFindings).toHaveLength(2);
    expect(out.advisoryFindings.map((f: { message: string }) => f.message)).toEqual(["tz bug", "inline const"]);
  });
});
