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
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";

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
  test("[US-001 AC 1] context.v2.fragments.enabled defaults to false", () => {
    const config = NaxConfigSchema.parse({});
    expect(fragmentsBlock(config as Record<string, unknown>).enabled).toBe(false);
  });

  test("[US-001 AC 2] context.v2.fragments.decay defaults to 0.6", () => {
    const config = NaxConfigSchema.parse({});
    expect(fragmentsBlock(config as Record<string, unknown>).decay).toBe(0.6);
  });

  test("[US-001 AC 3] context.v2.fragments.maxTokens defaults to 400", () => {
    const config = NaxConfigSchema.parse({});
    expect(fragmentsBlock(config as Record<string, unknown>).maxTokens).toBe(400);
  });

  test("[US-001 AC 4] context.v2.fragments.extractor defaults to 'deterministic'", () => {
    const config = NaxConfigSchema.parse({});
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
