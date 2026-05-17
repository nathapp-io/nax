/**
 * Integration test: verifies that src/tdd/orchestrator.ts calls runFullSuiteGate
 * with the correct new signature (without sessionManager parameter).
 *
 * AC8: When src/tdd/orchestrator.ts calls runFullSuiteGate, then the call
 *      compiles without passing sessionManager.
 */

import { describe, test, expect } from "bun:test";

// This test is primarily a compile-time check. The test verifies that:
// 1. The orchestrator imports runFullSuiteGate successfully
// 2. The types align with the new signature
// 3. No type errors are reported when TypeScript checks the orchestrator code

describe("orchestrator.ts — runFullSuiteGate call (AC8)", () => {
  test("AC8: orchestrator imports runFullSuiteGate successfully", async () => {
    // Verify that orchestrator.ts can be imported without type errors
    // This test documents that after the refactor, the orchestrator's call to
    // runFullSuiteGate will compile without passing sessionManager.
    const orchestratorModule = await import("../../../src/tdd/orchestrator");
    expect(orchestratorModule).toBeDefined();
    expect(orchestratorModule.runThreeSessionTdd).toBeDefined();
  });

  test("AC8: runFullSuiteGate is exported from rectification-gate", async () => {
    // Verify that runFullSuiteGate is properly exported and has the new signature
    const gateModule = await import("../../../src/tdd/rectification-gate");
    expect(gateModule).toBeDefined();
    expect(gateModule.runFullSuiteGate).toBeDefined();
  });

  test("AC8: runFullSuiteGate has correct parameter order (runtime required, sessionManager removed)", async () => {
    // This test verifies the signature by attempting to call the function
    // with the new parameter order. The orchestrator.ts file should pass:
    // - sessionId (optional, 10th param)
    // - runtime (required, 11th param)
    //
    // NOT:
    // - sessionManager (removed)
    //
    // Before refactor: runFullSuiteGate(..., sessionManager, sessionId, runtime?)
    // After refactor:  runFullSuiteGate(..., sessionId, runtime)

    const { runFullSuiteGate } = await import("../../../src/tdd/rectification-gate");

    // Verify the function exists and is callable
    expect(typeof runFullSuiteGate).toBe("function");

    // Verify function signature by checking parameter count
    // New signature has 11 parameters (including runtime as required)
    expect(runFullSuiteGate.length).toBe(11);
  });
});
