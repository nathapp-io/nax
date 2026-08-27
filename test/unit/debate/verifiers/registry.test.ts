/**
 * Tests for src/debate/verifiers/registry.ts
 * AC 6: resolvePostDebateVerifier throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for unknown kinds.
 */

import { describe, expect, it } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { resolvePostDebateVerifier } from "@/debate";

describe("resolvePostDebateVerifier", () => {
  it("throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for unknown kind", () => {
    let caught: unknown;
    try {
      resolvePostDebateVerifier("nonexistent-kind");
    } catch (e) {
      caught = e;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("POST_DEBATE_VERIFIER_UNKNOWN");
  });

  it("throws NaxError with code POST_DEBATE_VERIFIER_UNKNOWN for empty string", () => {
    let caught: unknown;
    try {
      resolvePostDebateVerifier("");
    } catch (e) {
      caught = e;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("POST_DEBATE_VERIFIER_UNKNOWN");
  });
});
