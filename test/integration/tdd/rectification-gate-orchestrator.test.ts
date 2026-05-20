/**
 * Verifies the new callOp-based TDD dispatch API surface (US-005.S5).
 *
 * AC8: The ops-layer TDD functions are exported from their respective barrels.
 * The legacy runThreeSessionTdd / runFullSuiteGate surfaces have been retired
 * from the test tree in favour of the individual ops dispatch pattern.
 */

import { describe, expect, test } from "bun:test";

describe("TDD ops API surface (US-005.S5)", () => {
  test("testWriterOp is exported from src/tdd barrel", async () => {
    const tddModule = await import("../../../src/tdd");
    expect(tddModule.testWriterOp).toBeDefined();
    expect(tddModule.testWriterOp.kind).toBe("run");
  });

  test("implementerOp is exported from src/tdd barrel", async () => {
    const tddModule = await import("../../../src/tdd");
    expect(tddModule.implementerOp).toBeDefined();
    expect(tddModule.implementerOp.kind).toBe("run");
  });

  test("verifierOp is exported from src/tdd barrel", async () => {
    const tddModule = await import("../../../src/tdd");
    expect(tddModule.verifierOp).toBeDefined();
    expect(tddModule.verifierOp.kind).toBe("run");
  });

  test("fullSuiteGateOp is exported from src/operations barrel", async () => {
    const opsModule = await import("../../../src/operations");
    expect(opsModule.fullSuiteGateOp).toBeDefined();
    // US-005 AC#1: fullSuiteGateOp was converted from RunOperation to DeterministicOperation
    expect(opsModule.fullSuiteGateOp.kind).toBe("deterministic");
  });
});
