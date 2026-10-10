import { expect, test } from "bun:test";

test("AC-1: Importing runAcceptanceFixCycle and _acceptanceFixCycleDeps from both @/execution/lifecycle/acceptance-loop and @/execution/lifecycle/acceptance-fix-cycle yields references where acceptanceLoop.runAcceptanceFixCycle === acceptanceFixCycle.runAcceptanceFixCycle and acceptanceLoop._acceptanceFixCycleDeps === acceptanceFixCycle._acceptanceFixCycleDeps are both true.", async () => {
  const acceptanceLoop = await import("@/execution/lifecycle/acceptance-loop");
  const acceptanceFixCycle = await import("@/execution/lifecycle/acceptance-fix-cycle");

  expect(typeof acceptanceFixCycle.runAcceptanceFixCycle).toBe("function");
  expect(acceptanceFixCycle._acceptanceFixCycleDeps).toBeDefined();
  expect(acceptanceLoop.runAcceptanceFixCycle).toBe(acceptanceFixCycle.runAcceptanceFixCycle);
  expect(acceptanceLoop._acceptanceFixCycleDeps).toBe(acceptanceFixCycle._acceptanceFixCycleDeps);
});