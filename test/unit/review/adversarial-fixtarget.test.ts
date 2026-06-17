/**
 * Tests for adversarial findings carrying fixTarget through both
 * cycle-facing (Finding) and audit-facing (ReviewFinding) converters.
 *
 * US-002 — every AC must be covered by exactly one test.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { toAdversarialReviewFindings } from "../../../src/review/adversarial-helpers";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import { _adversarialDeps, llmFindingsToReviewFindings } from "@/review";
import { _reviewAuditDeps, ReviewAuditor } from "@/runtime";
import type { ReviewAuditEntry } from "@/runtime";

const { writeReviewAudit } = _adversarialDeps;

function makeAdversarialFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return {
    severity: "error",
    category: "abandonment",
    file: "src/foo.ts",
    line: 5,
    issue: "missing branch",
    suggestion: "add the missing branch",
    ...overrides,
  };
}

describe("toAdversarialReviewFindings — fixTarget tagging", () => {
  test('AC1: category "abandonment" tags fixTarget="source"', () => {
    const result = toAdversarialReviewFindings([
      makeAdversarialFinding({ category: "abandonment" }),
    ]);
    expect(result[0].fixTarget).toBe("source");
  });

  test('AC2: category "test-gap" tags fixTarget="test"', () => {
    const result = toAdversarialReviewFindings([
      makeAdversarialFinding({ category: "test-gap" }),
    ]);
    expect(result[0].fixTarget).toBe("test");
  });
});

describe("llmFindingsToReviewFindings — fixTarget tagging", () => {
  test('AC3: category "input" with source "adversarial-review" tags fixTarget="source"', () => {
    const result = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "input" })],
      { source: "adversarial-review" },
    );
    expect(result[0].fixTarget).toBe("source");
  });

  test('AC5: unrecognized category tags fixTarget="test"', () => {
    const result = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "some-unrecognized-category" })],
      { source: "adversarial-review" },
    );
    expect(result[0].fixTarget).toBe("test");
  });
});

describe("converter parity for fixTarget", () => {
  test('AC4: same adversarial finding through toAdversarialReviewFindings and llmFindingsToReviewFindings yields matching fixTarget', () => {
    const finding = makeAdversarialFinding({ category: "abandonment" });
    const cycle = toAdversarialReviewFindings([finding]);
    const audit = llmFindingsToReviewFindings([finding], { source: "adversarial-review" });
    expect(cycle[0].fixTarget).toBe(audit[0].fixTarget);
    expect(cycle[0].fixTarget).toBe("source");
  });
});

describe("review audit persistence — fixTarget rides through to disk", () => {
  let saved: typeof _reviewAuditDeps;

  beforeEach(() => {
    saved = { ..._reviewAuditDeps };
  });

  test('AC6: persisted audit entry for category "abandonment" carries fixTarget="source" on the stored finding', async () => {
    const written: Array<{ path: string; content: string }> = [];
    Object.assign(_reviewAuditDeps, {
      mkdir: async () => {},
      writeFile: async (path: string, content: string) => {
        written.push({ path, content });
      },
      now: () => 1700000000000,
      findNaxProjectRoot: async (dir: string) => dir,
    });

    const reviewFindings = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "abandonment" })],
      { source: "adversarial-review" },
    );
    const entry: ReviewAuditEntry = {
      reviewer: "adversarial",
      sessionName: "nax-abc-my-feature-us-001-reviewer-adversarial",
      workdir: "/tmp/workdir",
      storyId: "US-001",
      featureName: "my-feature",
      parsed: true,
      result: { passed: false, findings: reviewFindings },
    };
    await writeReviewAudit(entry);
    Object.assign(_reviewAuditDeps, saved);

    expect(written).toHaveLength(1);
    const persisted = JSON.parse(written[0].content);
    expect(persisted.result.findings).toHaveLength(1);
    expect(persisted.result.findings[0].fixTarget).toBe("source");
  });
});
