/**
 * AC5: SOURCE_TO_CHECK maps "tdd-verifier" → "test"
 *
 * Verifies that:
 * - findingsToFailedChecks groups a tdd-verifier finding under check "test"
 * - The source file contains the canonical "tdd-verifier": "test" line
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined } from "@test/helpers";
import type { Finding } from "@/findings/types";

const BASE = join(import.meta.dir, "../../../src/operations");

const TDD_VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "3 story-scoped test(s) failed (verifier)",
  fixTarget: "source",
};

describe("AC5: SOURCE_TO_CHECK maps tdd-verifier to test check", () => {
  test("AC5: findingsToFailedChecks maps tdd-verifier finding to check 'test'", async () => {
    const { findingsToFailedChecks } = await import("@/operations");
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    expect(results.length).toBe(1);
    expect(results[0].check).toBe("test");
  });

  test("AC5: grouped check has success=false", async () => {
    const { findingsToFailedChecks } = await import("@/operations");
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    // Guard: fails assertively if tdd-verifier not mapped in SOURCE_TO_CHECK
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].success).toBe(false);
  });

  test("AC5: grouped check findings contains the tdd-verifier finding", async () => {
    const { findingsToFailedChecks } = await import("@/operations");
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    // Guard: fails assertively if tdd-verifier not mapped in SOURCE_TO_CHECK
    expect(results.length).toBeGreaterThan(0);
    const groupedFindings = results[0].findings;
    assertDefined(groupedFindings, "results[0].findings");
    expect(groupedFindings.length).toBe(1);
    expect(groupedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC5: source file contains exactly one tdd-verifier: test line in SOURCE_TO_CHECK", async () => {
    const file = Bun.file(join(BASE, "_finding-to-check.ts"));
    const content = await file.text();
    const matches = content.split("\n").filter((line) => /^\s*"tdd-verifier": "test",\s*$/.test(line));
    expect(matches.length).toBe(1);
  });
});
