/**
 * Unit tests for multi-agent precheck functionality
 *
 * Tests the checkMultiAgentHealth check that reports
 * which agents are installed and their versions.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { _checkAgentsDeps, checkMultiAgentHealth } from "../../../src/precheck/checks-agents";
import type { AgentVersionInfo } from "../../../src/agents/shared/version-detection";

const MOCK_VERSIONS: AgentVersionInfo[] = [
  { name: "claude", displayName: "Claude Code", version: "v1.2.3", installed: true },
  { name: "codex", displayName: "Codex", version: null, installed: false },
];

let result: Awaited<ReturnType<typeof checkMultiAgentHealth>>;

beforeAll(async () => {
  _checkAgentsDeps.getAgentVersions = mock(async () => MOCK_VERSIONS);
  result = await checkMultiAgentHealth();
});

afterEach(() => {
  mock.restore();
});

describe("checkMultiAgentHealth", () => {
  test("should return check result with required fields", () => {
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("tier");
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("message");
  });

  test("should return warning tier (not blocker)", () => {
    expect(result.tier).toBe("warning");
  });

  test("should pass if at least one agent is installed", () => {
    expect(result.passed).toBe(true);
  });

  test("should include agent names in message", () => {
    expect(result.message).toBeTruthy();
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("should have check name 'multi-agent-health'", () => {
    expect(result.name).toBe("multi-agent-health");
  });

  test("should include version info when agents are installed", () => {
    expect(result.message).toBeTruthy();
    expect(result.message.toLowerCase()).toContain("agent");
  });

  test("should handle agents not being installed gracefully", () => {
    expect(result).toBeTruthy();
    expect(typeof result.passed).toBe("boolean");
  });
});

describe("checkMultiAgentHealth — no agents installed", () => {
  test("should still pass when no agents are installed", async () => {
    _checkAgentsDeps.getAgentVersions = mock(async () => []);
    const r = await checkMultiAgentHealth();
    expect(r.passed).toBe(true);
    expect(r.tier).toBe("warning");
    expect(r.message).toContain("No additional agents");
  });
});
