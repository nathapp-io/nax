/**
 * ModelMapSchema — models.<agent>.<tier>.pricing.tiers (nax#1847)
 *
 * TokenPricing carries an optional `tiers` array so a config override can
 * express threshold pricing the same way nax-ai's catalog does. Zod objects
 * strip unknown keys rather than rejecting them, so a `tiers` array missing
 * from the schema would be dropped at config load with no error and no
 * warning — the run would silently bill at base rates, and a malformed tier
 * would validate. This pins that the schema carries the field through.
 */

import { describe, expect, test } from "bun:test";
import { ModelMapSchema } from "@/config/schemas-model";

const TIERED = {
  inputPer1M: 2,
  outputPer1M: 12,
  cacheReadPer1M: 0.2,
  cacheCreationPer1M: 2.5,
  tiers: [{ inputTokensAbove: 272000, inputPer1M: 4, outputPer1M: 18, cacheReadPer1M: 0.4, cacheCreationPer1M: 5 }],
};

/**
 * Per-agent shape deliberately, not the legacy flat one: a flat map is
 * migrated under the default agent, which would make the assertion path
 * depend on that migration rather than on the pricing schema.
 */
function parseTiers(pricing: unknown): unknown {
  const parsed = ModelMapSchema.parse({
    claude: { balanced: { provider: "openai", model: "gpt-5.6-terra", pricing } },
  });
  const entry = parsed.claude?.balanced;
  // ModelEntry is `ModelDef | string`; narrowing rather than casting keeps
  // this off the loose-cast ratchet.
  if (entry === undefined || typeof entry === "string") return undefined;
  return entry.pricing?.tiers;
}

describe("models.<agent>.<tier>.pricing.tiers", () => {
  test("survives config validation instead of being stripped", () => {
    expect(parseTiers(TIERED)).toEqual(TIERED.tiers);
  });

  test("pricing without tiers still validates", () => {
    expect(parseTiers({ inputPer1M: 2, outputPer1M: 12 })).toBeUndefined();
  });

  test("rejects a tier missing its threshold", () => {
    expect(() => parseTiers({ ...TIERED, tiers: [{ inputPer1M: 4, outputPer1M: 18 }] })).toThrow();
  });
});
