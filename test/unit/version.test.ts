/**
 * US-003 (Persist rate provenance on cost rows) — NAX_AI_VERSION export.
 *
 * Covers acceptance criterion 9:
 *
 *   - AC9: `NAX_AI_VERSION` is imported from the version module as a
 *     non-empty string matching the dotted numeric form
 *     `<major>.<minor>.<patch>`.
 *
 * The constant is read at build time from nax's own `package.json`
 * `dependencies["@nathapp/nax-ai"]` (the catalog's own manifest declares
 * only the package root in its `exports` map, so a runtime read of the
 * catalog's own version is unavailable). The bundler inlines the read
 * as a constant, so a published `dist/nax.js` build carries the version
 * without resolving the catalog at runtime.
 */

import { describe, expect, test } from "bun:test";
import { NAX_AI_VERSION, NAX_VERSION } from "@/version";

describe("NAX_AI_VERSION (US-003 AC9)", () => {
  test("AC9: NAX_AI_VERSION is a non-empty string when the catalog pin is readable", () => {
    // The constant may be `undefined` when the catalog pin is unreadable at
    // build time (US-003 AC12) — under that state, this test is the one that
    // validates the contract on a NORMAL install where the dependency
    // resolves. The undefined case is pinned separately (see AC12 in
    // cost-rate-provenance.test.ts).
    expect(NAX_AI_VERSION).toBeDefined();
    if (NAX_AI_VERSION === undefined) throw new Error("expected NAX_AI_VERSION to be defined");
    expect(typeof NAX_AI_VERSION).toBe("string");
    expect(NAX_AI_VERSION.length).toBeGreaterThan(0);
  });

  test("AC9: NAX_AI_VERSION matches the <major>.<minor>.<patch> dotted numeric form", () => {
    expect(NAX_AI_VERSION).toBeDefined();
    if (NAX_AI_VERSION === undefined) throw new Error("expected NAX_AI_VERSION to be defined");
    expect(NAX_AI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("AC9: NAX_VERSION (own package) also matches the dotted numeric form", () => {
    // Pin the contract on the sibling export — the new NAX_AI_VERSION
    // constant must follow the same shape as the existing one.
    expect(NAX_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
