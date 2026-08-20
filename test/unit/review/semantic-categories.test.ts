/**
 * Semantic finding category taxonomy (audit recommendation #6).
 *
 * July 2026 harness audit: 269 semantic blocking findings carried no category,
 * making 53% of review rounds invisible to recurrence-demotion fingerprinting,
 * curator aggregation, and review-audit telemetry. These tests pin the closed
 * taxonomy, its normalizer, and the prompt-facing enum rendering that keeps the
 * reviewer prompt from drifting away from the validator.
 */

import { describe, expect, test } from "bun:test";
import type { Iteration } from "@/findings";
import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CATEGORY_ENUM_LINE,
  classifyRecurrence,
  llmFindingsToReviewFindings,
  normalizeSemanticCategory,
  validateLLMShape,
} from "@/review";
import { llmFindingToFinding, parseLLMResponse } from "@/review/semantic-helpers";

/** A prior round in which the same semantic finding was already reported. */
function priorIterationWith(file: string, category: string, message: string): Iteration {
  return {
    iterationNum: 1,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [{ source: "semantic-review", severity: "error", category, file, message }],
    outcome: "fixes-applied",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:01.000Z",
  } as Iteration;
}

describe("SEMANTIC_CATEGORIES", () => {
  test("is the closed semantic taxonomy — AC-fulfillment axes only", () => {
    expect([...SEMANTIC_CATEGORIES]).toEqual([
      "unimplemented",
      "partial",
      "contradiction",
      "dead-path",
      "unwired",
      "other",
    ]);
  });

  test("excludes adversarial-owned categories so the two reviewers stay distinguishable", () => {
    // Semantic's role explicitly puts test coverage and conventions out of
    // scope; reusing adversarial's vocabulary would both invite scope creep and
    // wrongly trip the `test-gap` carve-out in recurrence-demotion.
    for (const adversarialOnly of ["test-gap", "convention", "input", "error-path", "abandonment", "assumption"]) {
      expect(SEMANTIC_CATEGORIES as readonly string[]).not.toContain(adversarialOnly);
    }
  });
});

describe("normalizeSemanticCategory()", () => {
  test("passes through every known category unchanged", () => {
    for (const category of SEMANTIC_CATEGORIES) {
      expect(normalizeSemanticCategory(category)).toBe(category);
    }
  });

  test.each([
    ["  Contradiction  ", "contradiction"],
    ["DEAD-PATH", "dead-path"],
  ])("trims and lowercases %p -> %p", (raw, expected) => {
    expect(normalizeSemanticCategory(raw)).toBe(expected);
  });

  test.each([
    [undefined, ""],
    [null, ""],
    ["", ""],
    ["   ", ""],
    [42, ""],
  ])("absent or non-string %p yields the empty category", (raw, expected) => {
    expect(normalizeSemanticCategory(raw)).toBe(expected);
  });

  test.each(["test-gap", "security", "made-up"])(
    "unrecognized category %p collapses to 'other' rather than polluting fingerprints",
    (raw) => {
      expect(normalizeSemanticCategory(raw)).toBe("other");
    },
  );
});

describe("SEMANTIC_CATEGORY_ENUM_LINE", () => {
  test("renders the taxonomy as a quoted JSON union", () => {
    expect(SEMANTIC_CATEGORY_ENUM_LINE).toBe(
      '"unimplemented" | "partial" | "contradiction" | "dead-path" | "unwired" | "other"',
    );
  });
});

describe("validateLLMShape() — normalization at the parse boundary", () => {
  const wire = (category?: string) =>
    JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          ...(category === undefined ? {} : { category }),
          file: "src/a.ts",
          line: 4,
          issue: "AC 1 only handles the happy path",
          suggestion: "handle the empty case",
        },
      ],
    });

  test("canonicalises case and whitespace, so two rounds of the same axis fingerprint alike", () => {
    const first = parseLLMResponse(wire("Partial"));
    const second = parseLLMResponse(wire("  partial "));
    expect(first?.findings[0].category).toBe("partial");
    expect(second?.findings[0].category).toBe("partial");
  });

  test("maps an off-taxonomy category to 'other' before any consumer sees it", () => {
    expect(parseLLMResponse(wire("missing-validation"))?.findings[0].category).toBe("other");
  });

  test("leaves the field absent when the reviewer omits it, rather than inventing an empty key", () => {
    const parsed = parseLLMResponse(wire(undefined));
    expect(parsed?.findings[0]).not.toHaveProperty("category");
  });

  test("drops non-object entries instead of passing them to consumers that dereference them", () => {
    // An LLM that emits `findings: [null]` or a bare string used to survive the
    // parse boundary untouched, then threw on the first `f.severity` read deep
    // in a consumer. The parse boundary is where a malformed entry is cheap to
    // discard — every consumer downstream assumes a finding-shaped object.
    const parsed = parseLLMResponse(
      JSON.stringify({
        passed: false,
        findings: [
          null,
          "the tests are inadequate",
          42,
          { severity: "error", category: "partial", file: "src/a.ts", line: 1, issue: "real", suggestion: "fix" },
        ],
      }),
    );
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0]).toMatchObject({ issue: "real", category: "partial" });
  });

  test("preserves every other field on the finding", () => {
    const finding = parseLLMResponse(wire("Contradiction"))?.findings[0];
    expect(finding).toMatchObject({
      severity: "error",
      file: "src/a.ts",
      line: 4,
      issue: "AC 1 only handles the happy path",
      suggestion: "handle the empty case",
    });
  });
});

describe("downstream consumers read the normalized category", () => {
  const parse = (category: string) =>
    validateLLMShape({
      passed: false,
      findings: [{ severity: "error", category, file: "test/unit/a.test.ts", line: 1, issue: "AC 1 unmet", suggestion: "fix" }],
    })?.findings ?? [];

  test("review-audit / curator ruleId is derived from the canonical category", () => {
    // `Partial` and `partial` must not split into two curator H1 buckets.
    const [upper] = llmFindingsToReviewFindings(parse("Partial"), { source: "semantic-review" });
    const [lower] = llmFindingsToReviewFindings(parse("partial"), { source: "semantic-review" });
    expect(upper.category).toBe("partial");
    expect(upper.ruleId).toBe(lower.ruleId);
    expect(upper.ruleId.startsWith("partial:")).toBe(true);
  });

  test("a stray 'test-gap' cannot reach the adversarial test-gap carve-out in recurrence-demotion", () => {
    // The carve-out force-blocks a test-gap finding on a test file, bypassing
    // demotion entirely — that is adversarial machinery. A semantic reviewer
    // that ignores its own taxonomy must not be able to trip it.
    const findings = parse("test-gap");
    expect(findings[0].category).toBe("other");
    const { blocking, demoted } = classifyRecurrence(
      findings,
      [priorIterationWith("test/unit/a.test.ts", "other", "AC 1 unmet"), priorIterationWith("test/unit/a.test.ts", "other", "AC 1 unmet")],
      { enabled: true, maxBlockingRounds: 1 },
      () => true,
      "error",
      "semantic-review",
    );
    expect(blocking).toHaveLength(0);
    expect(demoted).toHaveLength(1);
  });
});

describe("llmFindingToFinding() category population", () => {
  const base = { severity: "error", file: "src/a.ts", line: 1, issue: "AC 1 not implemented", suggestion: "implement" };

  test("carries a valid category through to the unified Finding", () => {
    expect(llmFindingToFinding({ ...base, category: "unimplemented" }).category).toBe("unimplemented");
  });

  test("normalizes an unrecognized category to 'other'", () => {
    expect(llmFindingToFinding({ ...base, category: "made-up" }).category).toBe("other");
  });

  test("keeps the empty category when the reviewer omits the field (pre-taxonomy behaviour)", () => {
    expect(llmFindingToFinding(base).category).toBe("");
  });

  test("never emits 'test-gap', which would trip the recurrence-demotion carve-out", () => {
    expect(llmFindingToFinding({ ...base, category: "test-gap" }).category).toBe("other");
  });

  test("category does not change the semantic fix lane — semantic fixes always land in source", () => {
    expect(llmFindingToFinding({ ...base, category: "dead-path" }).fixTarget).toBe("source");
    expect(llmFindingToFinding({ ...base, category: "unwired" }).fixTarget).toBe("source");
  });
});
