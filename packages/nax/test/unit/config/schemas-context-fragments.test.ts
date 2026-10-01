/**
 * US-001: context.v2.fragments schema defaults
 *
 * Adds a `fragments` block to ContextV2Config with these defaults:
 *   - enabled: false  (opt-in)
 *   - decay: 0.6      (multiplier in [0, 1])
 *   - maxTokens: 400  (per-fragment budget)
 *   - extractor: "deterministic"  (only accepted value in this spec)
 *
 * AC 1–5 are mirrored in this file. The outer default literal in `schemas.ts`
 * shadows the inner schema defaults because Zod does not re-parse default
 * values, so both sites must carry the new block (see the file-level note in
 * `schemas-context.ts`).
 *
 * This file also carries two satellites merged in per the test-consolidation
 * drain: `schemas-review-advisory-rounds` (US-002 advisory recurrence cap) and
 * `schemas-context-defaults` (context defaults are schema-derived).
 */

import { describe, expect, test } from "bun:test";
import {
  AdversarialReviewConfigSchema,
  ContextConfigSchema,
  ContextV2ConfigSchema,
  DEFAULT_CONFIG,
  NaxConfigSchema,
  SemanticReviewConfigSchema,
} from "@/config";

function fragmentsConfig(fragments: Record<string, unknown> | undefined) {
  const base: Record<string, unknown> = { ...DEFAULT_CONFIG };
  if (fragments !== undefined) {
    const context = base.context as Record<string, unknown>;
    const v2 = { ...(context.v2 as Record<string, unknown>), fragments };
    base.context = { ...context, v2 };
  }
  return base;
}

function fragmentsBlock(config: Record<string, unknown>): Record<string, unknown> {
  const context = config.context as Record<string, unknown>;
  const v2 = context.v2 as Record<string, unknown>;
  return v2.fragments as Record<string, unknown>;
}

describe("ContextV2ConfigSchema — fragments block (US-001)", () => {
  test("[US-001 AC 1] context.v2.fragments.enabled defaults to false (+3 more assertions)", () => {
    const config = NaxConfigSchema.parse({});
    expect(fragmentsBlock(config as Record<string, unknown>).enabled).toBe(false);
    expect(fragmentsBlock(config as Record<string, unknown>).decay).toBe(0.6);
    expect(fragmentsBlock(config as Record<string, unknown>).maxTokens).toBe(400);
    expect(fragmentsBlock(config as Record<string, unknown>).extractor).toBe("deterministic");
  });

  test("[US-001 AC 5] decay = 1.5 fails schema validation", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ decay: 1.5 }));
    expect(result.success).toBe(false);
  });

  test("decay = 0 is accepted (lower boundary inclusive)", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ decay: 0 }));
    expect(result.success).toBe(true);
  });

  test("decay = 1 is accepted (upper boundary inclusive)", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ decay: 1 }));
    expect(result.success).toBe(true);
  });

  test("decay = -0.1 fails schema validation", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ decay: -0.1 }));
    expect(result.success).toBe(false);
  });

  test("extractor = 'llm' is rejected — this spec accepts only 'deterministic'", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ extractor: "llm" }));
    expect(result.success).toBe(false);
  });

  test("partial override preserves defaults: enabled = true keeps decay/maxTokens/extractor", () => {
    const config = NaxConfigSchema.parse(fragmentsConfig({ enabled: true }));
    const fragments = fragmentsBlock(config as Record<string, unknown>);
    expect(fragments.enabled).toBe(true);
    expect(fragments.decay).toBe(0.6);
    expect(fragments.maxTokens).toBe(400);
    expect(fragments.extractor).toBe("deterministic");
  });

  test("maxTokens rejects 0 (must be >= 1)", () => {
    const result = NaxConfigSchema.safeParse(fragmentsConfig({ maxTokens: 0 }));
    expect(result.success).toBe(false);
  });
});

// US-002: Configure advisory recurrence cap (absorbed schemas-review-advisory-rounds)

describe("AdversarialReviewConfigSchema.recurrenceDemotion.maxAdvisoryRounds", () => {
  // AC1: When adversarial recurrenceDemotion.maxAdvisoryRounds is unset, schema parsing resolves it to 2.
  test("US-002-AC1: defaults to 2 when unset", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(2);
  });

  // AC5: When adversarial recurrenceDemotion.maxAdvisoryRounds is 5, schema parsing resolves it to 5.
  test("US-002-AC5: accepts explicit value of 5", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      recurrenceDemotion: { maxAdvisoryRounds: 5 },
    });
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(5);
  });

  // AC4: When either review config sets recurrenceDemotion.maxAdvisoryRounds to 0, schema validation rejects it.
  test("US-002-AC4: rejects 0 on adversarial", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      recurrenceDemotion: { maxAdvisoryRounds: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("SemanticReviewConfigSchema.recurrenceDemotion.maxAdvisoryRounds", () => {
  // AC2: When semantic recurrenceDemotion.maxAdvisoryRounds is unset, schema parsing resolves it to 2.
  test("US-002-AC2: defaults to 2 when unset", () => {
    const parsed = SemanticReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(2);
  });

  // AC4: When either review config sets recurrenceDemotion.maxAdvisoryRounds to 0, schema validation rejects it.
  test("US-002-AC4: rejects 0 on semantic", () => {
    const result = SemanticReviewConfigSchema.safeParse({
      recurrenceDemotion: { maxAdvisoryRounds: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("SemanticReviewConfigSchema.recurrenceDemotion.enabled default", () => {
  // AC3: When semantic recurrenceDemotion.enabled is unset, schema parsing resolves it to false.
  test("US-002-AC3: enabled defaults to false when recurrenceDemotion is provided", () => {
    const parsed = SemanticReviewConfigSchema.parse({
      recurrenceDemotion: {},
    });
    expect(parsed.recurrenceDemotion.enabled).toBe(false);
  });
});

// Context config defaults — one source of truth (absorbed schemas-context-defaults).
//
// `NaxConfigSchema` used to attach a hand-written `.default({...})` literal to
// the `context` block that restated every inner `.default()`. Zod does not
// re-parse a default value, so that literal *shadowed* the schema: a field
// added to `ContextConfigSchema` but forgotten in the literal would be absent
// from `parse({})` (and from DEFAULT_CONFIG) while still resolving correctly
// whenever an operator supplied the parent partially.
//
// These tests pin both halves of that asymmetry, so the literal cannot return.

describe("context config defaults are schema-derived", () => {
  test("the root-derived context block equals a direct ContextConfigSchema parse", () => {
    expect(NaxConfigSchema.parse({}).context).toEqual(ContextConfigSchema.parse({}));
  });

  test("the root-derived v2 block equals a direct ContextV2ConfigSchema parse", () => {
    expect(NaxConfigSchema.parse({}).context.v2).toEqual(ContextV2ConfigSchema.parse({}));
  });

  test("an empty parent and a partially supplied parent agree on every inner default", () => {
    // The shadowing bug is invisible unless both paths are compared: the literal
    // fed `parse({})`, while a partial parent went through the real sub-schemas.
    const empty = NaxConfigSchema.parse({}).context.v2;
    const partial = NaxConfigSchema.parse({ context: { v2: { enabled: true } } }).context.v2;

    expect({ ...partial, enabled: false }).toEqual(empty);
  });

  test("a partially supplied nested block keeps its siblings' defaults", () => {
    const parsed = NaxConfigSchema.parse({ context: { v2: { fragments: { enabled: true } } } }).context.v2;

    expect(parsed.fragments).toEqual({ enabled: true, decay: 0.6, maxTokens: 400, extractor: "deterministic" });
    expect(parsed.pull).toEqual(ContextV2ConfigSchema.parse({}).pull);
  });
});
