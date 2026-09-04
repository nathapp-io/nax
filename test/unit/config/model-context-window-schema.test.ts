/**
 * ModelMapSchema — models.<agent>.<tier>.contextWindow (nax#1848)
 *
 * ModelDef carries an optional `contextWindow` so a config override can
 * correct a stale catalog window, or lower it to make compaction
 * observable (compactAtPercent floors at 50, and real windows are large
 * enough that 50% of them is still hundreds of thousands of tokens). Zod
 * objects strip unknown keys rather than rejecting them, so a
 * `contextWindow` missing from the schema would be dropped at config load
 * with no error -- the run would silently ignore it, exactly the failure
 * mode #1847 shipped for `pricing.tiers`. This pins that the schema carries
 * the field through.
 */

import { describe, expect, test } from "bun:test";
import { ModelMapSchema } from "@/config/schemas-model";

/**
 * Per-agent shape deliberately, not the legacy flat one: a flat map is
 * migrated under the default agent, which would make the assertion path
 * depend on that migration rather than on the schema field itself.
 */
function parseContextWindow(contextWindow: unknown): unknown {
  const parsed = ModelMapSchema.parse({
    claude: { balanced: { provider: "openai", model: "gpt-5.6-terra", contextWindow } },
  });
  const entry = parsed.claude?.balanced;
  // ModelEntry is `ModelDef | string`; narrowing rather than casting keeps
  // this off the loose-cast ratchet.
  if (entry === undefined || typeof entry === "string") return undefined;
  return entry.contextWindow;
}

describe("models.<agent>.<tier>.contextWindow", () => {
  test("survives config validation instead of being stripped", () => {
    expect(parseContextWindow(20_000)).toBe(20_000);
  });

  test("absent contextWindow still validates", () => {
    const parsed = ModelMapSchema.parse({
      claude: { balanced: { provider: "openai", model: "gpt-5.6-terra" } },
    });
    const entry = parsed.claude?.balanced;
    if (entry === undefined || typeof entry === "string") throw new Error("expected a ModelDef entry");
    expect(entry.contextWindow).toBeUndefined();
  });

  test("rejects a non-numeric contextWindow", () => {
    expect(() => parseContextWindow("20000")).toThrow();
  });
});
