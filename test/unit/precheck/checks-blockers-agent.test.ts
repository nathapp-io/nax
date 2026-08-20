/**
 * Unit tests for AA-005: Refactor precheck to detect configured agent binary
 *
 * Tests the new checkAgentCLI function that reads the configured agent binary
 * from config and validates it exists and responds to --version.
 * Covers: claude, codex, opencode, gemini, aider, missing-binary, default behavior.
 */

import { describe, expect, mock, test, afterEach } from "bun:test";
import { checkAgentCLI, _deps } from "@/precheck/checks-blockers";
import { withDepsRestore } from "@test/helpers";
import { makeNaxConfig } from "@test/helpers";

// --- helpers ---

// MED-03: checkAgentCLI now resolves the configured agent via
// resolveDefaultAgent(config), which reads config.agent.default —
// config.execution.agent never existed in the schema and was always undefined.
function makeConfig(agent?: string) {
  return makeNaxConfig(
    agent === undefined
      ? {}
      : {
          agent: {
            default: agent,
          },
        },
  );
}

withDepsRestore(_deps, ["spawn"]);

// --- tests ---

describe("checkAgentCLI — default behavior (claude)", () => {
  test("uses claude by default and on explicit config; passes with correct fields and success message", async () => {
    for (const agent of [undefined, "claude"] as const) {
      const calls: string[][] = [];
      _deps.spawn = mock((cmd: string[]) => {
        calls.push(cmd);
        return { exited: Promise.resolve(0), stdout: null, stderr: null };
      });
      await checkAgentCLI(makeConfig(agent));
      expect(calls[0][0], `agent=${agent}`).toBe("claude");
    }
    _deps.spawn = mock((_cmd: string[]) => ({ exited: Promise.resolve(0), stdout: null, stderr: null }));
    const result = await checkAgentCLI(makeConfig("claude"));
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("blocker");
    expect(result.name).toBe("agent-cli-available");
    expect(result.message).toContain("claude");
  });
});

describe("checkAgentCLI — non-claude agents", () => {
  test("spawns correct binary and passes when exit 0 for codex, opencode, gemini, aider", async () => {
    for (const agent of ["codex", "opencode", "gemini", "aider"] as const) {
      const calls: string[][] = [];
      _deps.spawn = mock((cmd: string[]) => {
        calls.push(cmd);
        return { exited: Promise.resolve(0), stdout: null, stderr: null };
      });
      const result = await checkAgentCLI(makeConfig(agent));
      expect(calls[0][0], agent).toBe(agent);
      expect(result.passed, agent).toBe(true);
    }
  });

  test("failure message contains the binary name when binary is missing for all agents", async () => {
    for (const agent of ["claude", "codex", "opencode", "gemini", "aider"] as const) {
      _deps.spawn = mock((_cmd: string[]) => {
        throw new Error("ENOENT: not found");
      });
      const result = await checkAgentCLI(makeConfig(agent));
      expect(result.passed, agent).toBe(false);
      expect(result.message, agent).toContain(agent);
    }
  });
});

describe("checkAgentCLI — missing binary (non-zero exit)", () => {
  test("returns blocker on non-zero exit or ENOENT; check name is agent-cli-available", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({ exited: Promise.resolve(1), stdout: null, stderr: null }));
    const r1 = await checkAgentCLI(makeConfig("claude"));
    expect(r1.passed).toBe(false);
    expect(r1.tier).toBe("blocker");

    _deps.spawn = mock((_cmd: string[]) => { throw new Error("ENOENT"); });
    const r2 = await checkAgentCLI(makeConfig("codex"));
    expect(r2.passed).toBe(false);
    expect(r2.tier).toBe("blocker");
    expect(r2.name).toBe("agent-cli-available");
  });
});

describe("checkAgentCLI — --version flag patterns", () => {
  test("all agents invoke binary with --version flag", async () => {
    for (const agent of ["claude", "aider", "codex"] as const) {
      const calls: string[][] = [];
      _deps.spawn = mock((cmd: string[]) => {
        calls.push(cmd);
        return { exited: Promise.resolve(0), stdout: null, stderr: null };
      });
      await checkAgentCLI(makeConfig(agent));
      expect(calls[0], agent).toContain("--version");
    }
  });
});

describe("checkAgentCLI — no regression on checkClaudeCLI", () => {
  test("checkClaudeCLI still exists and works as before", async () => {
    const { checkClaudeCLI } = await import("@/precheck/checks-blockers");

    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkClaudeCLI();

    expect(result.name).toBe("claude-cli-available");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
  });
});
