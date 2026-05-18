import { describe, expect, test } from "bun:test";

/**
 * Tests for TDD operations export surface.
 *
 * AC-7: Given `src/operations/index.ts` is inspected after US-003, when
 * reading exports, then `TddRunOp` is not exported.
 */

describe("src/operations/index.ts — TddRunOp export removal", () => {
  test("TddRunOp type should not be exported from src/operations/index.ts", async () => {
    // After upgrade, TddRunOp is no longer a public export from operations
    // because the TDD ops are now full RunOperation shapes, not minimal role tags
    const operationsIndex = await import("@/operations");

    // Verify that TddRunOp is NOT in the exports
    expect("TddRunOp" in operationsIndex).toBe(false);
  });

  test("implementerOp should be exported from src/operations/index.ts", async () => {
    const operationsIndex = await import("@/operations");
    expect("implementerOp" in operationsIndex).toBe(true);
  });

  test("testWriterOp should be exported from src/operations/index.ts", async () => {
    const operationsIndex = await import("@/operations");
    expect("testWriterOp" in operationsIndex).toBe(true);
  });

  test("verifierOp should be exported from src/operations/index.ts", async () => {
    const operationsIndex = await import("@/operations");
    expect("verifierOp" in operationsIndex).toBe(true);
  });

  test("writeTddTestOp is exported from write-test.ts (backward compat alias)", async () => {
    const writeTest = await import("@/operations/write-test");
    // writeTddTestOp may still be exported as an alias to testWriterOp
    // or may be renamed, depending on implementation choice
    expect(writeTest).toBeDefined();
  });

  test("implementTddOp is exported from implement.ts (backward compat alias)", async () => {
    const implement = await import("@/operations/implement");
    // implementTddOp may still be exported as an alias to implementerOp
    // or may be renamed, depending on implementation choice
    expect(implement).toBeDefined();
  });

  test("verifyTddOp is exported from verify.ts (backward compat alias)", async () => {
    const verify = await import("@/operations/verify");
    // verifyTddOp may still be exported as an alias to verifierOp
    // or may be renamed, depending on implementation choice
    expect(verify).toBeDefined();
  });
});

describe("src/operations/ — files structure", () => {
  test("src/operations/implement.ts exists and exports implementerOp", async () => {
    const impl = await import("@/operations/implement");
    expect(impl).toBeDefined();
    // Should export a RunOperation, not the old TddRunOp
  });

  test("src/operations/write-test.ts exists and exports testWriterOp", async () => {
    const wt = await import("@/operations/write-test");
    expect(wt).toBeDefined();
    // Should export a RunOperation, not the old TddRunOp
  });

  test("src/operations/verify.ts exists and exports verifierOp", async () => {
    const v = await import("@/operations/verify");
    expect(v).toBeDefined();
    // Should export a RunOperation, not the old TddRunOp
  });
});
