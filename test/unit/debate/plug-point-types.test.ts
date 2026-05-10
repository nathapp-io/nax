/**
 * Tests for type exports from the three new strategy contract files.
 * AC 7: each file exports its respective Context, Result, and Strategy types.
 */

import { describe, expect, it } from "bun:test";

// Verify that the module can be imported (type-only exports are erased at runtime,
// but the module itself must exist and be importable without runtime errors).
describe("pre-phase/types.ts exports", () => {
  it("can import the module without errors", async () => {
    const mod = await import("../../../src/debate/pre-phase/types");
    // The module exists; TypeScript types are erased at runtime so we only
    // verify the module loads cleanly.
    expect(mod).toBeDefined();
  });
});

describe("selectors/types.ts exports", () => {
  it("can import the module without errors", async () => {
    const mod = await import("../../../src/debate/selectors/types");
    expect(mod).toBeDefined();
  });
});

describe("verifiers/types.ts exports", () => {
  it("can import the module without errors", async () => {
    const mod = await import("../../../src/debate/verifiers/types");
    expect(mod).toBeDefined();
  });
});
