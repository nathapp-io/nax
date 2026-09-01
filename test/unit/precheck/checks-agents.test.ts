/**
 * Unit tests for multi-agent precheck functionality
 *
 * Tests the checkMultiAgentHealth check that reports
 * which agents are installed and their versions.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { AgentVersionInfo } from "@/agents/shared/version-detection";
import { _checkAgentsDeps, checkMultiAgentHealth } from "@/precheck/checks-agents";

const MOCK_VERSIONS: AgentVersionInfo[] = [
  { name: "claude", displayName: "Claude Code", binary: "claude", version: "v1.2.3", installed: true },
  { name: "codex", displayName: "Codex", binary: "codex", version: null, installed: false },
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

  // BUG-19 (regression, caught in code review): getAgentVersions() briefly
  // marked every agent as installed, making this "available but not
  // installed" section unreachable regardless of what MOCK_VERSIONS says.
  test("lists agents with installed: false under 'Available but not installed'", () => {
    expect(result.message).toContain("Available but not installed");
    expect(result.message).toContain("Codex");
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

describe("checkMultiAgentHealth — version label honesty", () => {
  // I-1 (final review): native is installed by construction but has no binary
  // and no version — " (version unknown)" implied a probe that never ran.
  test("adapterless installed agent (no binary, no version) renders ' (no binary)'", async () => {
    _checkAgentsDeps.getAgentVersions = mock(async () => [
      { name: "native", displayName: "Native (nax-ai)", binary: "", version: null, installed: true },
    ]);
    const r = await checkMultiAgentHealth();
    expect(r.message).toContain("Native (nax-ai) (no binary)");
    expect(r.message).not.toContain("version unknown");
  });

  test("agent with a binary but undetectable version keeps ' (version unknown)'", async () => {
    _checkAgentsDeps.getAgentVersions = mock(async () => [
      { name: "claude", displayName: "Claude Code", binary: "claude", version: null, installed: true },
    ]);
    const r = await checkMultiAgentHealth();
    expect(r.message).toContain("Claude Code (version unknown)");
    expect(r.message).not.toContain("(no binary)");
  });
});
