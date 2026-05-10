/**
 * Tests for src/debate/verifiers/registry.ts
 * AC 6: resolvePostDebateVerifier throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for unknown kinds.
 */

import { describe, expect, it } from "bun:test";
import { NaxError } from "../../../../src/errors";
import { resolvePostDebateVerifier } from "../../../../src/debate/verifiers/registry";

describe("resolvePostDebateVerifier", () => {
  it("throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for unknown kind", () => {
    let caught: unknown;
    try {
      resolvePostDebateVerifier("nonexistent-kind");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("POST_DEBATE_VERIFIER_UNKNOWN");
  });

  it("throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for empty string", () => {
    let caught: unknown;
    try {
      resolvePostDebateVerifier("");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("POST_DEBATE_VERIFIER_UNKNOWN");
  });
});
