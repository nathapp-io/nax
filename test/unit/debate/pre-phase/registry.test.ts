/**
 * Tests for src/debate/pre-phase/registry.ts
 * AC 6: resolvePreDebatePhase throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for unknown kinds.
 */

import { describe, expect, it } from "bun:test";
import { resolvePreDebatePhase } from "@/debate";
import { NaxError } from "@/errors";

describe("resolvePreDebatePhase", () => {
  it("throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for unknown kind", () => {
    let caught: unknown;
    try {
      resolvePreDebatePhase("nonexistent-kind");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("PRE_DEBATE_PHASE_UNKNOWN");
  });

  it("throws NaxError with code PRE_DEBATE_PHASE_UNKNOWN for empty string", () => {
    let caught: unknown;
    try {
      resolvePreDebatePhase("");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("PRE_DEBATE_PHASE_UNKNOWN");
  });
});
