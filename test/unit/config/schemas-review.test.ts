// test/unit/config/schemas-review.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema, NaxConfigSchema, ReviewConfigSchema } from "@/config";
import type { FixReviewConfig } from "@/config/selectors";

// Type-level assertions (compile-time, no runtime body) — US-001.
//
// The `FixReviewConfig` type alias is what downstream readers (US-003 runner,
// `resolveFixReviewModel`'s callers) actually consult. It MUST describe the
// parsed shape — `enabled` and `timeoutMs` carry schema defaults, so every
// parsed value has them — not the input shape, which leaves every field
// optional and forces every reader to re-default a value that is never
// actually absent at runtime.
//
// The neighbour `NonBlockingFixConfig` is declared with `z.infer` for exactly
// this reason. `FixReviewConfig` is declared with `z.input` (#adversarial
// review, `selectors.ts:186`); these assertions fail to compile until that
// alias is corrected. The runtime tests below (AC1-AC4) already pin the
// behaviour; this pins the *type*.
//
// AssertTrue is the project-standard compile-time guard
// (see test/unit/execution/lifecycle/run-regression.test.ts, "Asserted at
// the type level, not with @ts-expect-error on a value literal"). It fails
// to typecheck (TS2344) if the type argument is the wrong literal — there is
// no runtime path that can quietly turn a wrong type green.
//
// Each assertion is built on a TS-level conditional, not a runtime expression:
//   * `enabled` and `timeoutMs` must extend `boolean`/`number` directly.
//     `(boolean | undefined) extends boolean` is `false`, so a `z.input`
//     declaration (which makes every field optional) trips both.
//   * `model` must allow `undefined` (the schema declares `.optional()`).
//     `undefined extends ConfiguredModel` is `false`, so a `z.input` trip
//     would surface here too — the control on the *positive* assertion
//     catches what the negative-direction assertions miss.
type AssertTrue<T extends true> = T;

type AssertFixReviewEnabledIsRequired = AssertTrue<FixReviewConfig["enabled"] extends boolean ? true : false>;
type AssertFixReviewTimeoutMsIsRequired = AssertTrue<FixReviewConfig["timeoutMs"] extends number ? true : false>;
type AssertFixReviewModelIsOptional = AssertTrue<undefined extends FixReviewConfig["model"] ? true : false>;

const _fixReviewEnabledIsRequired: AssertFixReviewEnabledIsRequired = true;
const _fixReviewTimeoutMsIsRequired: AssertFixReviewTimeoutMsIsRequired = true;
const _fixReviewModelIsOptional: AssertFixReviewModelIsOptional = true;

describe("AdversarialReviewConfigSchema.recurrenceDemotion", () => {
  test("defaults to enabled with maxBlockingRounds 2", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion).toEqual({ enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 });
  });
  test("accepts overrides", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      recurrenceDemotion: { enabled: false, maxBlockingRounds: 3 },
    });
    expect(parsed.recurrenceDemotion).toEqual({ enabled: false, maxBlockingRounds: 3, maxAdvisoryRounds: 2 });
  });
});

describe("ReviewConfigSchema.conflictDetection", () => {
  test("defaults enabled with maxOscillations 2", () => {
    const parsed = ReviewConfigSchema.parse({ enabled: true, checks: [], commands: {} });
    expect(parsed.conflictDetection).toEqual({ enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 });
  });

  test("accepts a maxOscillations override", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      conflictDetection: { maxOscillations: 4 },
    });
    expect(parsed.conflictDetection.maxOscillations).toBe(4);
  });
});

/**
 * US-001 — `review.fixReview` (the scoped review of a fix's own delta).
 * AC1-AC3 read the field through `NaxConfigSchema.parse({})` — the DEFAULT_CONFIG
 * path — because that is the value an unconfigured repo actually runs on;
 * `ReviewConfigSchema` alone would only prove the inner schema is well-formed.
 * AC4 pins the constraint on `timeoutMs`.
 */
describe("ReviewConfigSchema.fixReview (US-001)", () => {
  test("US-001 AC1: NaxConfigSchema.parse({}) defaults review.fixReview.enabled to true", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.review.fixReview).toBeDefined();
    expect(parsed.review.fixReview.enabled).toBe(true);
  });

  test("US-001 AC2: NaxConfigSchema.parse({}) defaults review.fixReview.timeoutMs to 600000", () => {
    expect(NaxConfigSchema.parse({}).review.fixReview.timeoutMs).toBe(600_000);
  });

  test("US-001 AC3: NaxConfigSchema.parse({}) carries a fixReview block with no model", () => {
    const fixReview = NaxConfigSchema.parse({}).review.fixReview;
    expect(fixReview.model).toBeUndefined();
    // The block still carries its two defaults: "no model" is a real absence in
    // a populated block, not an empty placeholder that would pass vacuously.
    expect(fixReview).toEqual({ enabled: true, timeoutMs: 600_000 });
  });

  test("US-001 AC3 boundary: a configured review.fixReview.model round-trips through a full config", () => {
    const parsed = NaxConfigSchema.parse({
      review: {
        enabled: true,
        checks: [],
        commands: {},
        fixReview: { model: { agent: "claude", model: "claude-opus-4-6" } },
      },
    });
    expect(parsed.review.fixReview.model).toEqual({ agent: "claude", model: "claude-opus-4-6" });
  });

  test("US-001 AC4: NaxConfigSchema rejects review.fixReview.timeoutMs 0 with an issue on that path", () => {
    const result = NaxConfigSchema.safeParse({ review: { fixReview: { timeoutMs: 0 } } });
    const issuePaths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(result.success).toBe(false);
    expect(issuePaths).toContain("review.fixReview.timeoutMs");
  });

  test("US-001 AC4 boundary: on a complete review config, timeoutMs 0 is the ONLY rejected path", () => {
    const result = NaxConfigSchema.safeParse({
      review: { enabled: true, checks: [], commands: {}, fixReview: { timeoutMs: 0 } },
    });
    const issuePaths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(result.success).toBe(false);
    expect(issuePaths).toEqual(["review.fixReview.timeoutMs"]);
  });
});
