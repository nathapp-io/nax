// test/unit/config/non-blocking-fix-config.test.ts
//
// US-001 — non-blocking-fix config moved from `review.adversarial.nonBlockingFix`
// to a standalone `review.nonBlockingFix` with a `sources` array of reviewer
// names. These tests assert:
//   - the new standalone schema's defaults (AC1, AC2)
//   - the `sources` enum and validation (AC3, AC4)
//   - the new key's absence is an absence, not a default (AC5)
//   - the AdversarialReviewConfigSchema no longer carries nonBlockingFix (AC10)
//   - the migration shim handles legacy / canonical / mixed inputs (AC6-AC9)

import { describe, expect, test } from "bun:test";
import type { ConfigWarnLogger } from "@/config/migrations";
import { migrateLegacyNonBlockingFix } from "@/config/migrations";
import { AdversarialReviewConfigSchema, NonBlockingFixConfigSchema, ReviewConfigSchema } from "@/config/schemas-review";

type NonBlockingFixLogger = ConfigWarnLogger;

/** Walk a key path through a raw (pre-Zod) config object, yielding `undefined`
 * whenever any hop is missing — mirrors the optional-chain reads the
 * `migrateLegacyTestPattern` test suite uses, so the new shim's tests can
 * avoid per-read `as Record<string, unknown>` casts. */
function probe(root: unknown, keys: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in (current as object))) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("NonBlockingFixConfigSchema — defaults and validation (AC1, AC2)", () => {
  test("AC1: empty object resolves to the documented default shape", () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    });
  });

  test('AC2: sources defaults to ["adversarial"]', () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed.sources).toEqual(["adversarial"]);
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
    const message = (thrown as Error).message ?? String(thrown);
    expect(message).toContain("sources");
  });

  test("rejects an empty sources array", () => {
    expect(() => NonBlockingFixConfigSchema.parse({ sources: [] })).toThrow();
  });

  test("scope: 'triage' parses successfully", () => {
    const parsed = NonBlockingFixConfigSchema.parse({ enabled: true, scope: "triage" });
    expect(parsed.scope).toBe("triage");
  });

  test("scope: defaults to 'both' when unset", () => {
    const parsed = NonBlockingFixConfigSchema.parse({});
    expect(parsed.scope).toBe("both");
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

  test("ReviewConfigSchema parses review.nonBlockingFix and exposes it as a typed slice", () => {
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

describe("migrateLegacyNonBlockingFix — AC6, AC7, AC8, AC9", () => {
  function captureWarnings(): { messages: string[]; fakeLogger: NonBlockingFixLogger | null } {
    const messages: string[] = [];
    const fakeLogger: NonBlockingFixLogger = {
      warn: (_stage: string, msg: string) => messages.push(msg),
    };
    return { messages, fakeLogger };
  }

  test("AC6: only legacy is supplied — canonical slice resolves to the legacy value and emits one config warning naming both keys", () => {
    const { messages, fakeLogger } = captureWarnings();
    const legacy = { enabled: true, scope: "triage", regressionAttempts: 2, verifierGuard: false };
    const raw: Record<string, unknown> = {
      review: { adversarial: { nonBlockingFix: legacy } },
    };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);

    expect(probe(result, ["review", "nonBlockingFix"])).toEqual(legacy);
    expect(probe(result, ["review", "adversarial", "nonBlockingFix"])).toBeUndefined();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("review.adversarial.nonBlockingFix");
    expect(messages[0]).toContain("review.nonBlockingFix");
  });

  test("AC7: both legacy and canonical are supplied — canonical wins, one warning names both keys, no throw", () => {
    const { messages, fakeLogger } = captureWarnings();
    const legacy = { enabled: false, scope: "source" };
    const canonical = { enabled: true, scope: "triage", sources: ["semantic"] };
    const raw: Record<string, unknown> = {
      review: {
        adversarial: { nonBlockingFix: legacy },
        nonBlockingFix: canonical,
      },
    };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);
    expect(probe(result, ["review", "nonBlockingFix"])).toEqual(canonical);
    expect(probe(result, ["review", "adversarial", "nonBlockingFix"])).toBeUndefined();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("review.adversarial.nonBlockingFix");
    expect(messages[0]).toContain("review.nonBlockingFix");
  });

  test("AC7 (no-throw): calling the migration with both keys present does not throw", () => {
    const { fakeLogger } = captureWarnings();
    const raw: Record<string, unknown> = {
      review: {
        adversarial: { nonBlockingFix: { enabled: false } },
        nonBlockingFix: { enabled: true },
      },
    };
    expect(() => migrateLegacyNonBlockingFix(raw, fakeLogger)).not.toThrow();
  });

  test("AC8: neither legacy nor canonical is supplied — migration returns the config unchanged and emits no warning", () => {
    const { messages, fakeLogger } = captureWarnings();
    const raw: Record<string, unknown> = { review: { adversarial: { rules: [] } } };
    const result = migrateLegacyNonBlockingFix(raw, fakeLogger);
    expect(result).toBe(raw);
    expect(messages.length).toBe(0);
  });

  test("AC9: legacy in one layer + canonical in a later layer — after migration runs pre-merge, the later canonical value wins", () => {
    const { messages, fakeLogger } = captureWarnings();
    const legacyLayer: Record<string, unknown> = {
      review: { adversarial: { nonBlockingFix: { enabled: false, scope: "source" } } },
    };
    const canonicalLayer: Record<string, unknown> = {
      review: { nonBlockingFix: { enabled: true, scope: "triage", sources: ["semantic", "adversarial"] } },
    };
    // Per-layer migration, then merge (later overrides earlier).
    const migratedLegacy = migrateLegacyNonBlockingFix(legacyLayer, fakeLogger);
    const migratedCanonical = migrateLegacyNonBlockingFix(canonicalLayer, fakeLogger);
    // Canonical layer should not warn (it has no legacy key).
    const messagesBeforeMerge = [...messages];
    expect(messagesBeforeMerge.length).toBe(1);

    // Mimic deepMergeConfig: later layer's keys win.
    const mergedReview = mergeReview(migratedLegacy.review, migratedCanonical.review);
    expect(probe({ review: mergedReview }, ["review", "nonBlockingFix"])).toEqual({
      enabled: true,
      scope: "triage",
      sources: ["semantic", "adversarial"],
    });
    // Legacy value no longer present anywhere.
    expect(probe({ review: mergedReview }, ["review", "adversarial", "nonBlockingFix"])).toBeUndefined();
  });
});

/** Merge two `review` slices — later keys win — without per-call `as` casts. */
function mergeReview(a: unknown, b: unknown): Record<string, unknown> {
  return { ...(a as Record<string, unknown>), ...(b as Record<string, unknown>) };
}
