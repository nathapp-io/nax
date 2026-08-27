/**
 * Tests for src/debate/pre-phase/registry.ts
 * AC 6: resolvePreDebatePhase throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for unknown kinds.
 */

import { describe, expect, it } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { resolvePreDebatePhase } from "@/debate";

describe("resolvePreDebatePhase", () => {
  it("throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for unknown kind", () => {
    let caught: unknown;
    try {
      resolvePreDebatePhase("nonexistent-kind");
    } catch (e) {
      caught = e;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("PRE_DEBATE_PHASE_UNKNOWN");
  });

  it("throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for empty string", () => {
    let caught: unknown;
    try {
      resolvePreDebatePhase("");
    } catch (e) {
      caught = e;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("PRE_DEBATE_PHASE_UNKNOWN");
  });
});
