/**
 * Tests for AcpTokenUsageMapper — wire-format decoupling (Issue 708 Phase A)
 *
 * Covers:
 * - Full snake_case to camelCase mapping
 * - Undefined cache fields stay undefined
 * - Zero values are preserved
 * - Default mapper instance exists
 */

import { describe, expect, test } from "bun:test";
import { AcpTokenUsageMapper, defaultAcpTokenUsageMapper } from "../../../../src/agents/acp/token-mapper";
import type { SessionTokenUsage } from "../../../../src/agents/acp/wire-types";

describe("AcpTokenUsageMapper", () => {
  test("maps full snake_case wire to camelCase internal", () => {
    const wire: SessionTokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    };
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(100);
    expect(internal.outputTokens).toBe(50);
    expect(internal.cacheReadInputTokens).toBe(10);
    expect(internal.cacheCreationInputTokens).toBe(5);
  });

  test("undefined cache fields remain undefined", () => {
    const wire: SessionTokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
    };
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(100);
    expect(internal.outputTokens).toBe(50);
    expect(internal.cacheReadInputTokens).toBeUndefined();
    expect(internal.cacheCreationInputTokens).toBeUndefined();
  });

  test("zero values are preserved (not coerced to undefined)", () => {
    const wire: SessionTokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(0);
    expect(internal.outputTokens).toBe(0);
    expect(internal.cacheReadInputTokens).toBe(0);
    expect(internal.cacheCreationInputTokens).toBe(0);
  });

  test("defaultAcpTokenUsageMapper is a singleton instance", () => {
    expect(defaultAcpTokenUsageMapper).toBeInstanceOf(AcpTokenUsageMapper);
  });
});

describe("BUG-10 — malformed wire token values do not pass through as non-numbers", () => {
  test("a string input_tokens is coerced to 0, not kept as a string", () => {
    // acpx can emit a malformed wire record; only `?? 0` guards undefined/null,
    // not non-numeric types. Cast is unavoidable here — we're deliberately
    // simulating a runtime contract violation the compiler would otherwise block.
    const wire = { input_tokens: "123", output_tokens: 50 } as unknown as SessionTokenUsage; // test-ratchet-allow: as-unknown-as
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(0);
    expect(typeof internal.inputTokens).toBe("number");
  });

  test("a string output_tokens is coerced to 0, not kept as a string", () => {
    const wire = { input_tokens: 10, output_tokens: "50" } as unknown as SessionTokenUsage; // test-ratchet-allow: as-unknown-as
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.outputTokens).toBe(0);
    expect(typeof internal.outputTokens).toBe("number");
  });

  test("a non-finite numeric value (NaN) is coerced to 0", () => {
    const wire = { input_tokens: Number.NaN, output_tokens: 50 } as unknown as SessionTokenUsage; // test-ratchet-allow: as-unknown-as
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(0);
  });

  test("valid numeric values still pass through unaffected", () => {
    const wire: SessionTokenUsage = { input_tokens: 100, output_tokens: 50 };
    const mapper = new AcpTokenUsageMapper();
    const internal = mapper.toInternal(wire);

    expect(internal.inputTokens).toBe(100);
    expect(internal.outputTokens).toBe(50);
  });

  // BUG-58: cache_read_input_tokens / cache_creation_input_tokens must get the
  // same finite-number guard as input_tokens / output_tokens — previously they
  // were assigned through unvalidated, leaving the exact BUG-10 corruption path
  // (string-concat / NaN propagation) reachable via these two fields.
  test("a string cache_read_input_tokens is coerced to 0, not kept as a string", () => {
    const wire = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: "123",
    } as unknown as SessionTokenUsage; // test-ratchet-allow: as-unknown-as
    const internal = new AcpTokenUsageMapper().toInternal(wire);

    expect(internal.cacheReadInputTokens).toBe(0);
    expect(typeof internal.cacheReadInputTokens).toBe("number");
  });

  test("a string cache_creation_input_tokens is coerced to 0, not kept as a string", () => {
    const wire = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: "9",
    } as unknown as SessionTokenUsage; // test-ratchet-allow: as-unknown-as
    const internal = new AcpTokenUsageMapper().toInternal(wire);

    expect(internal.cacheCreationInputTokens).toBe(0);
    expect(typeof internal.cacheCreationInputTokens).toBe("number");
  });

  test("a non-finite cache_read_input_tokens (NaN) is coerced to 0", () => {
    const wire: SessionTokenUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: Number.NaN,
    };
    const internal = new AcpTokenUsageMapper().toInternal(wire);

    expect(internal.cacheReadInputTokens).toBe(0);
  });

  test("cache fields still stay undefined when absent (unaffected by the guard)", () => {
    const wire: SessionTokenUsage = { input_tokens: 10, output_tokens: 5 };
    const internal = new AcpTokenUsageMapper().toInternal(wire);

    expect(internal.cacheReadInputTokens).toBeUndefined();
    expect(internal.cacheCreationInputTokens).toBeUndefined();
  });
});
