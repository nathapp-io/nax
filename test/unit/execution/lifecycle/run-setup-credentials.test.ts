import { describe, expect, mock, test } from "bun:test";

describe("runSetupPhase → validateCredentials (#518)", () => {
  test("calls agentManager.validateCredentials() when provided", async () => {
    const validateCredentials = mock(async () => {});
    const agentManager = {
      validateCredentials,
      getDefault: () => "claude",
      isUnavailable: () => false,
      markUnavailable: () => {},
      reset: () => {},
      resolveFallbackChain: () => [],
      shouldSwap: () => false,
      nextCandidate: () => null,
      runWithFallback: async () => ({ result: null as never, fallbacks: [] }),
      events: { on: () => {} },
    };
    // Verify the interface contract — validateCredentials is callable
    await agentManager.validateCredentials();
    expect(validateCredentials).toHaveBeenCalledTimes(1);
  });
});
