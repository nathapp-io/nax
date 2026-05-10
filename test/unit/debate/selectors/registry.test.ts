/**
 * Tests for src/debate/selectors/registry.ts
 * AC 6: resolveSelector throws NaxError with code SELECTOR_UNKNOWN for unknown kinds.
 */

import { describe, expect, it } from "bun:test";
import { NaxError } from "../../../../src/errors";
import { resolveSelector } from "../../../../src/debate/selectors/registry";

describe("resolveSelector", () => {
  it("throws NaxError with code SELECTOR_UNKNOWN for unknown kind", () => {
    let caught: unknown;
    try {
      resolveSelector("nonexistent-kind");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("SELECTOR_UNKNOWN");
  });

  it("throws NaxError with code SELECTOR_UNKNOWN for empty string", () => {
    let caught: unknown;
    try {
      resolveSelector("");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("SELECTOR_UNKNOWN");
  });
});
