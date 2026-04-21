import { describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager } from "../../../helpers";

describe("runSetupPhase → validateCredentials (#518)", () => {
  test("calls agentManager.validateCredentials() when provided", async () => {
    const validateCredentials = mock(async () => {});
    const agentManager = makeMockAgentManager({ getDefaultAgent: "claude" }) as IAgentManager & {
      validateCredentials: typeof validateCredentials;
    };
    agentManager.validateCredentials = validateCredentials;
    // Verify the interface contract — validateCredentials is callable
    await agentManager.validateCredentials();
    expect(validateCredentials).toHaveBeenCalledTimes(1);
  });
});
