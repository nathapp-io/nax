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
