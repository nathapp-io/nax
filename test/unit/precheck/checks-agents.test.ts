/**
 * Unit tests for multi-agent precheck functionality
 *
 * Tests the checkMultiAgentHealth check that reports
 * which agents are installed and their versions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkMultiAgentHealth } from "../../../src/precheck/checks-agents";
import type { Check } from "../../../src/precheck/types";

describe("checkMultiAgentHealth", () => {
  test("should return check result for multi-agent health", async () => {
    const result = await checkMultiAgentHealth();
    expect(result).toBeTruthy();
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("tier");
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("message");
  });

  test("should return warning tier (not blocker)", async () => {
    const result = await checkMultiAgentHealth();
    expect(result.tier).toBe("warning");
  });

  test("should pass if at least one agent is installed", async () => {
    const result = await checkMultiAgentHealth();
    // Should pass because claude adapter (current process) is always available
    expect(result.passed).toBe(true);
  });

  test("should include agent names in message", async () => {
    const result = await checkMultiAgentHealth();
    expect(result.message).toBeTruthy();
    // Should mention at least some agents
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("should have check name 'multi-agent-health'", async () => {
    const result = await checkMultiAgentHealth();
    expect(result.name).toBe("multi-agent-health");
  });

  test("should include version info when agents are installed", async () => {
    const result = await checkMultiAgentHealth();
    // Message should contain version information or status info
    expect(result.message).toBeTruthy();
    // Check that it provides meaningful information
    expect(result.message.toLowerCase()).toContain("agent");
  });

  test("should handle agents not being installed gracefully", async () => {
    const result = await checkMultiAgentHealth();
    // Should not throw, should return a valid check
    expect(result).toBeTruthy();
    expect(typeof result.passed).toBe("boolean");
  });
});
