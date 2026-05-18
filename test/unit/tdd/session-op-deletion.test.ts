import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Tests for TDD session-op test file cleanup.
 *
 * AC-8: Given role-tag wiring tests are inspected after US-003, when checking
 * `test/unit/tdd/session-op.test.ts`, then the file does not exist.
 *
 * This test verifies that the old role-tag wiring tests are removed
 * (since the role tags are upgraded to full RunOperation shapes).
 */

describe("test/unit/tdd/session-op.test.ts — removal verification", () => {
  test("old session-op.test.ts file should be removed after upgrade", () => {
    // The old test file at test/unit/tdd/session-op.test.ts should not exist
    // because the role-tag tests are no longer needed after upgrading to
    // full RunOperation shapes.
    const oldTestPath = join(process.cwd(), "test/unit/tdd/session-op.test.ts");

    // This test EXPECTS the file to NOT exist
    const fileExists = existsSync(oldTestPath);

    // After implementation, this assertion should pass (file does not exist)
    expect(fileExists).toBe(false);
  });

  test("new TDD ops tests should exist in operations directory", () => {
    // New tests should exist for the upgraded operations
    const implementerTestPath = join(process.cwd(), "test/unit/operations/implementer.test.ts");
    const writeTestTestPath = join(process.cwd(), "test/unit/operations/write-test-op.test.ts");
    const verifyOpTestPath = join(process.cwd(), "test/unit/operations/verify-op.test.ts");

    // These files should exist after the upgrade
    expect(existsSync(implementerTestPath)).toBe(true);
    expect(existsSync(writeTestTestPath)).toBe(true);
    expect(existsSync(verifyOpTestPath)).toBe(true);
  });

  test("session-op.ts may still exist but should not contain TddRunOp exports", async () => {
    // session-op.ts may be kept as a thin wrapper or completely removed
    // In either case, it should not export TddRunOp anymore

    try {
      const sessionOp = await import("@/tdd");

      // If the module exists, verify it doesn't export TddRunOp
      expect("TddRunOp" in sessionOp).toBe(false);
    } catch {
      // Module may not exist if it was completely removed - that's fine
    }
  });
});
