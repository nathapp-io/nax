/**
 * Tests for adversarial findings carrying fixTarget through both
 * cycle-facing (Finding) and audit-facing (ReviewFinding) converters.
 *
 * US-002 — every AC must be covered by exactly one test.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { llmFindingsToReviewFindings } from "@/review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import { toAdversarialReviewFindings } from "@/review/adversarial-helpers";
import { writeReviewAudit } from "@/review/review-audit";
import type { ReviewAuditEntry } from "@/runtime";
import { _reviewAuditDeps } from "@/runtime";

/** Stand-in for a `resolveTestFilePatterns`-derived classifier (ADR-009 SSOT). */
const isTestFile = (path: string) => /\.(test|spec)\.tsx?$/.test(path);

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
    const result = toAdversarialReviewFindings([makeAdversarialFinding({ category: "abandonment" })]);
    expect(result[0].fixTarget).toBe("source");
  });

  test('AC2: category "test-gap" tags fixTarget="test"', () => {
    const result = toAdversarialReviewFindings([makeAdversarialFinding({ category: "test-gap" })]);
    expect(result[0].fixTarget).toBe("test");
  });
});

describe("llmFindingsToReviewFindings — fixTarget tagging", () => {
  test('AC3: category "input" with source "adversarial-review" tags fixTarget="source"', () => {
    const result = llmFindingsToReviewFindings([makeAdversarialFinding({ category: "input" })], {
      source: "adversarial-review",
    });
    expect(result[0].fixTarget).toBe("source");
  });

  test('AC5: unrecognized category tags fixTarget="test"', () => {
    const result = llmFindingsToReviewFindings([makeAdversarialFinding({ category: "some-unrecognized-category" })], {
      source: "adversarial-review",
    });
    expect(result[0].fixTarget).toBe("test");
  });
});

describe("converter parity for fixTarget", () => {
  test("AC4: same adversarial finding through toAdversarialReviewFindings and llmFindingsToReviewFindings yields matching fixTarget", () => {
    const finding = makeAdversarialFinding({ category: "abandonment" });
    const cycle = toAdversarialReviewFindings([finding]);
    const audit = llmFindingsToReviewFindings([finding], { source: "adversarial-review" });
    expect(cycle[0].fixTarget).toBe(audit[0].fixTarget);
    expect(cycle[0].fixTarget).toBe("source");
  });

  test("both converters apply the test-path override identically (#1368)", () => {
    const finding = makeAdversarialFinding({ category: "abandonment", file: "test/app.module.spec.ts" });
    const cycle = toAdversarialReviewFindings([finding], { isTestFile });
    const audit = llmFindingsToReviewFindings([finding], { source: "adversarial-review", isTestFile });
    expect(cycle[0].fixTarget).toBe(audit[0].fixTarget);
    expect(cycle[0].fixTarget).toBe("test");
  });
});

describe("test-path override — a blocking category in a test file goes to the test lane (#1368)", () => {
  test("toAdversarialReviewFindings routes a test-file abandonment finding to the test lane", () => {
    // The redis-seams US-002 regression: a TestingModule-leak finding in a spec
    // file was tagged `source` and handed to the implementer, which cannot edit
    // tests and answered UNRESOLVED.
    const result = toAdversarialReviewFindings(
      [makeAdversarialFinding({ category: "abandonment", file: "test/app.module.redis-seams.spec.ts" })],
      { isTestFile },
    );
    expect(result[0].fixTarget).toBe("test");
  });

  test("a source-file abandonment finding still routes to the implementer", () => {
    const result = toAdversarialReviewFindings(
      [makeAdversarialFinding({ category: "abandonment", file: "src/app.module.ts" })],
      { isTestFile },
    );
    expect(result[0].fixTarget).toBe("source");
  });

  test("without a classifier the pre-#1368 category-only behaviour is preserved", () => {
    const result = toAdversarialReviewFindings([
      makeAdversarialFinding({ category: "abandonment", file: "test/app.module.spec.ts" }),
    ]);
    expect(result[0].fixTarget).toBe("source");
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

    const reviewFindings = llmFindingsToReviewFindings([makeAdversarialFinding({ category: "abandonment" })], {
      source: "adversarial-review",
    });
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
