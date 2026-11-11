// test/unit/config/non-blocking-fix-config.test.ts
//
// US-001 — non-blocking-fix config moved from `review.adversarial.nonBlockingFix`
// to a standalone `review.nonBlockingFix` with a `sources` array of reviewer
// names. These tests assert:
//   - the new standalone schema's defaults (AC1, AC2)
//   - the `sources` enum and validation (AC3, AC4)
//   - the new key's absence is an absence, not a default (AC5)
//   - the AdversarialReviewConfigSchema no longer carries nonBlockingFix (AC10)

import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema, NonBlockingFixConfigSchema, ReviewConfigSchema } from "@/config/schemas-review";

describe("NonBlockingFixConfigSchema — defaults and validation (AC1, AC2)", () => {
  test("AC1: empty object resolves to the documented default shape; AC2: sources defaults to [\"adversarial\"]; scope: defaults to 'both' when unset", () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    });
    expect(parsed.sources).toEqual(["adversarial"]);
    expect(parsed.scope).toBe("both");
  });

  test('AC3: sources ["adversarial", "semantic"] preserves both entries in declared order', () => {
    const parsed = NonBlockingFixConfigSchema.parse({ sources: ["adversarial", "semantic"] });
    expect(parsed.sources).toEqual(["adversarial", "semantic"]);
  });

  test("AC4: unrecognised reviewer name in sources rejects with a validation error naming sources", () => {
    let thrown: unknown = null;
    try {
      NonBlockingFixConfigSchema.parse({ sources: ["adversarial", "unknown-reviewer"] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("sources");
  });

  test("accepts an empty sources array — the 'neither' state from the four-state contract", () => {
    // The US-001 Approach paragraph names four states operators need:
    // adversarial-only, semantic-only, both, and neither. The "neither" state
    // is `sources: []` — nbf is configured (so the operator's `scope` and
    // `sourceDiffCap` settings survive) but it explicitly seeds from no
    // reviewer. US-002 AC15 ("sources empty... no findings... nbf should not
    // run") exercises exactly this shape end-to-end.
    const parsed = NonBlockingFixConfigSchema.parse({ sources: [] });
    expect(parsed.sources).toEqual([]);
  });

  test("scope: 'triage' parses successfully", () => {
    const parsed = NonBlockingFixConfigSchema.parse({ enabled: true, scope: "triage" });
    expect(parsed.scope).toBe("triage");
  });

  test("scope: rejects values outside source|both|triage", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ scope: "invalid" })).toThrow();
  });

  test("rejects negative regressionAttempts", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ regressionAttempts: -1 })).toThrow();
  });

  test("sourceDiffCap user values are preserved verbatim", () => {
    const parsed = NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: 3, maxLines: 50 } });
    expect(parsed.sourceDiffCap).toEqual({ maxFiles: 3, maxLines: 50 });
  });

  test("sourceDiffCap rejects negative values", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: -1, maxLines: 50 } })).toThrow();
    expect(() => NonBlockingFixConfigSchema.parse({ sourceDiffCap: { maxFiles: 5, maxLines: -10 } })).toThrow();
  });
});

describe("NonBlockingFixConfigSchema — worthCheck (US-001)", () => {
  test("US-001 AC17: leaves worthCheck undefined when the optional block is absent", () => {
    expect(NonBlockingFixConfigSchema.parse({}).worthCheck).toBeUndefined();
  });

  test("US-001 AC18: applies worth-check defaults when its config object is empty", () => {
    expect(NonBlockingFixConfigSchema.parse({ worthCheck: {} }).worthCheck).toEqual({
      mode: "off",
      timeoutMs: 300_000,
    });
  });

  test("US-001 AC19: rejects an unsupported worth-check mode", () => {
    expect(NonBlockingFixConfigSchema.safeParse({ worthCheck: { mode: "maybe" } }).success).toBe(false);
  });
});

describe("ReviewConfigSchema — nonBlockingFix is a top-level optional field (AC5, AC10)", () => {
  test("AC5: review.nonBlockingFix omitted — resolved slice is undefined and no nbf defaults are synthesised elsewhere", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
    });
    expect(parsed.nonBlockingFix).toBeUndefined();
    // Whether the adversarial block exists (defaults) or not, it never carries nonBlockingFix.
    if (parsed.adversarial !== undefined) {
      expect(parsed.adversarial).not.toHaveProperty("nonBlockingFix");
    }
  });

  test("AC10: AdversarialReviewConfigSchema strips nonBlockingFix — the parsed adversarial block has no nonBlockingFix property", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: { enabled: true, scope: "triage" },
    });
    expect(parsed).not.toHaveProperty("nonBlockingFix");
  });

  test("AdversarialReviewConfigSchema does not declare a nonBlockingFix field at all", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed).not.toHaveProperty("nonBlockingFix");
  });

  test("ReviewConfigSchema parses review.nonBlockingFix and exposes a typed slice", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      nonBlockingFix: { enabled: true, sources: ["semantic", "adversarial"] },
    });
    expect(parsed.nonBlockingFix).toBeDefined();
    expect(parsed.nonBlockingFix?.sources).toEqual(["semantic", "adversarial"]);
  });

  test("ReviewConfigSchema: review.nonBlockingFix accepts the documented defaults when explicit", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      nonBlockingFix: {
        enabled: false,
        scope: "both",
        regressionAttempts: 1,
        verifierGuard: true,
        sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        sources: ["adversarial"],
      },
    });
    expect(parsed.nonBlockingFix).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    });
  });
});
