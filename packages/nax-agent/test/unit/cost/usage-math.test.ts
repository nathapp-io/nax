/**
 * Tests for cost/usage-math.ts: addTokenUsage and inputClassTokens.
 *
 * Ported from nax's test/unit/agents/cost/calculate.test.ts (S2-3d). The
 * resolvePricingSource and formatCostWithConfidence describes stay in nax.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@nathapp/nax-ai";
import { addTokenUsage, inputClassTokens } from "#src/cost/usage-math";

describe("addTokenUsage", () => {
  test("adds input and output tokens", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
  });

  test("omits cache fields when both operands have them undefined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  test("includes cache fields when one operand has them defined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadTokens).toBe(10);
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  test("sums cache fields when both operands have them defined", () => {
    const a: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    const b: TokenUsage = {
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 20,
      cacheWriteTokens: 15,
    };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadTokens).toBe(30);
    expect(result.cacheWriteTokens).toBe(20);
  });

  test("preserves defined zero values in output", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadTokens).toBe(0);
  });

  test("returns zero totals when both operands are zero", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });
});

// ─── BUG-10: defense in depth against non-numeric operands ──────────────────
//
// addTokenUsage is a pure function reachable from upstream wire parsing (acpx
// -> parser.ts -> token-mapper.ts). If a malformed value ever slips past those
// guards, `+` on a string operand silently does concatenation ("123" + 100 ->
// "123100") instead of numeric addition, corrupting the running total and
// eventually producing "$NaN" costs. This block asserts the function is
// robust on its own, independent of whether upstream guards hold.
describe("addTokenUsage — BUG-10 malformed operand guard", () => {
  test("a string inputTokens does not trigger string concatenation", () => {
    // Deliberately violating the TokenUsage contract to simulate a value that
    // slipped past upstream numeric guards.
    const a = { inputTokens: "123", outputTokens: 50 } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const b: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(100);
    expect(typeof result.inputTokens).toBe("number");
  });

  test("a string outputTokens does not trigger string concatenation", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const b = { inputTokens: 50, outputTokens: "75" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const result = addTokenUsage(a, b);

    expect(result.outputTokens).toBe(25);
    expect(typeof result.outputTokens).toBe("number");
  });

  test("a non-finite operand (NaN) does not propagate NaN into the total", () => {
    const a: TokenUsage = { inputTokens: Number.NaN, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const result = addTokenUsage(a, b);

    expect(Number.isFinite(result.inputTokens)).toBe(true);
    expect(result.inputTokens).toBe(100);
  });

  // BUG-58: cacheReadTokens/cacheWriteTokens must get the same
  // malformed-operand guard as inputTokens/outputTokens — previously they were
  // summed with a bare `+`, reachable to the exact string-concat/NaN corruption
  // this whole describe block exists to prevent.
  test("a string cacheReadTokens does not trigger string concatenation", () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheReadTokens: "123" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const b: TokenUsage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 10 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadTokens).toBe(10);
    expect(typeof result.cacheReadTokens).toBe("number");
  });

  test("a string cacheWriteTokens does not trigger string concatenation", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 7 };
    const b = { inputTokens: 5, outputTokens: 2, cacheWriteTokens: "50" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const result = addTokenUsage(a, b);

    expect(result.cacheWriteTokens).toBe(7);
    expect(typeof result.cacheWriteTokens).toBe("number");
  });

  test("a non-finite cacheReadTokens (NaN) does not propagate NaN into the total", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: Number.NaN };
    const b: TokenUsage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 20 };
    const result = addTokenUsage(a, b);

    expect(Number.isFinite(result.cacheReadTokens)).toBe(true);
    expect(result.cacheReadTokens).toBe(20);
  });
});

describe("inputClassTokens", () => {
  test("sums input with cache reads and cache writes", () => {
    expect(
      inputClassTokens({
        inputTokens: 16,
        outputTokens: 900,
        cacheReadTokens: 71_755,
        cacheWriteTokens: 12_368,
      }),
    ).toBe(84_139);
  });

  test("treats absent cache fields as zero", () => {
    expect(inputClassTokens({ inputTokens: 500, outputTokens: 900 })).toBe(500);
  });

  test("excludes output tokens", () => {
    // Output is never part of the prompt the provider charged for. Asserted
    // explicitly because nax-ai's totalTokens() does include it, and reaching
    // for that helper here would double-count against the trailing estimate.
    expect(inputClassTokens({ inputTokens: 10, outputTokens: 10_000 })).toBe(10);
  });
});

describe("addTokenUsage key presence (S1-1)", () => {
  test("keeps absent cache fields absent and present zeroes present, in input/output/cacheRead/cacheWrite order", () => {
    expect(
      JSON.stringify(addTokenUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })),
    ).toBe('{"inputTokens":4,"outputTokens":6}');
    expect(
      JSON.stringify(
        addTokenUsage(
          { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 },
          { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5 },
        ),
      ),
    ).toBe('{"inputTokens":1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":5}');
  });
});
