/**
 * Amendment A AC-45: Effectiveness signal
 *
 * Unit tests for effectiveness.ts pure helpers:
 *   - classifyEffectiveness (per-chunk signal based on diff / output / findings)
 */

import { describe, expect, test } from "bun:test";
import { classifyEffectiveness } from "../../../../src/context/engine/effectiveness";

// ─────────────────────────────────────────────────────────────────────────────
// classifyEffectiveness
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyEffectiveness", () => {
  test("returns 'contradicted' when review finding message shares >=3 significant terms with chunk", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens stored in secure cookies for session management",
      "",
      "",
      ["JWT authentication tokens should not be stored in cookies — use Bearer headers"],
    );
    expect(result.signal).toBe("contradicted");
  });

  test("returns 'followed' when diff shares >=3 significant terms with chunk", () => {
    const result = classifyEffectiveness(
      "Use argon2 for password hashing in authentication module",
      "argon2 password hashing authentication implementation complete",
      "-old hash\n+argon2 password hashing authentication",
      [],
    );
    expect(result.signal).toBe("followed");
  });

  test("returns 'ignored' when chunk terms appear in neither diff nor output", () => {
    const result = classifyEffectiveness(
      "Cache invalidation should use distributed Redis cluster for session storage invalidation",
      "Updated the database connection pool settings",
      "-old setting\n+new setting for connection pool",
      [],
    );
    expect(result.signal).toBe("ignored");
  });

  test("returns 'unknown' when all inputs are empty", () => {
    const result = classifyEffectiveness("Some context chunk content here", "", "", []);
    expect(result.signal).toBe("unknown");
  });

  test("contradicted takes priority over followed", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens for session management validation",
      "jwt authentication session management",
      "-old\n+jwt authentication session management",
      ["JWT authentication tokens are no longer valid for session management validation"],
    );
    expect(result.signal).toBe("contradicted");
  });

  test("returns 'unknown' when chunk summary is too short for meaningful comparison", () => {
    const result = classifyEffectiveness("ok", "ok", "+ok", ["ok"]);
    expect(result.signal).toBe("unknown");
  });

  test("includes evidence string when signal is not unknown", () => {
    const result = classifyEffectiveness(
      "Use JWT authentication tokens stored in secure cookies for session management",
      "",
      "",
      ["JWT authentication tokens should not be stored in cookies — use Bearer headers"],
    );
    expect(result.evidence).toBeDefined();
    expect(typeof result.evidence).toBe("string");
  });
});
