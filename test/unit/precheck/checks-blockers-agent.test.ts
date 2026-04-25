/**
 * Unit tests for AA-005: Refactor precheck to detect configured agent binary
 *
 * Tests the new checkAgentCLI function that reads the configured agent binary
 * from config and validates it exists and responds to --version.
 * Covers: claude, codex, opencode, gemini, aider, missing-binary, default behavior.
 */

import { describe, expect, mock, test, afterEach } from "bun:test";
import { checkAgentCLI, _deps } from "../../../src/precheck/checks-blockers";
import { withDepsRestore } from "../../helpers/deps";
import { makeNaxConfig } from "../../helpers";

// --- helpers ---

function makeConfig(agent?: string) {
  return makeNaxConfig({
    execution: {
      agent: agent,
    },
  });
}

withDepsRestore(_deps, ["spawn"]);

// --- tests ---

describe("checkAgentCLI — default behavior (claude)", () => {
  test("passes when claude --version exits 0", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig());

    expect(result.passed).toBe(true);
    expect(result.tier).toBe("blocker");
    expect(result.name).toBe("agent-cli-available");
  });

  test("uses claude binary by default when no agent configured", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig());

    expect(calls[0][0]).toBe("claude");
  });

  test("uses claude binary when config.execution.agent is 'claude'", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("claude"));

    expect(calls[0][0]).toBe("claude");
  });

  test("passes success message containing 'claude' when binary found", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("claude"));

    expect(result.message).toContain("claude");
    expect(result.passed).toBe(true);
  });

  test("failure message contains 'claude' when claude binary missing", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT: not found");
    });

    const result = await checkAgentCLI(makeConfig("claude"));

    expect(result.passed).toBe(false);
    expect(result.message).toContain("claude");
  });
});

describe("checkAgentCLI — codex", () => {
  test("spawns codex binary when agent is 'codex'", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("codex"));

    expect(calls[0][0]).toBe("codex");
  });

  test("passes when codex --version exits 0", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("codex"));

    expect(result.passed).toBe(true);
  });

  test("failure message contains 'codex' when binary missing", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT: not found");
    });

    const result = await checkAgentCLI(makeConfig("codex"));

    expect(result.passed).toBe(false);
    expect(result.message).toContain("codex");
  });
});

describe("checkAgentCLI — opencode", () => {
  test("spawns opencode binary when agent is 'opencode'", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("opencode"));

    expect(calls[0][0]).toBe("opencode");
  });

  test("passes when opencode --version exits 0", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("opencode"));

    expect(result.passed).toBe(true);
  });

  test("failure message contains 'opencode' when binary missing", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT: not found");
    });

    const result = await checkAgentCLI(makeConfig("opencode"));

    expect(result.passed).toBe(false);
    expect(result.message).toContain("opencode");
  });
});

describe("checkAgentCLI — gemini", () => {
  test("spawns gemini binary when agent is 'gemini'", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("gemini"));

    expect(calls[0][0]).toBe("gemini");
  });

  test("passes when gemini --version exits 0", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("gemini"));

    expect(result.passed).toBe(true);
  });

  test("failure message contains 'gemini' when binary missing", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT: not found");
    });

    const result = await checkAgentCLI(makeConfig("gemini"));

    expect(result.passed).toBe(false);
    expect(result.message).toContain("gemini");
  });
});

describe("checkAgentCLI — aider", () => {
  test("spawns aider binary when agent is 'aider'", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("aider"));

    expect(calls[0][0]).toBe("aider");
  });

  test("passes when aider --version exits 0", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("aider"));

    expect(result.passed).toBe(true);
  });

  test("failure message contains 'aider' when binary missing", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT: not found");
    });

    const result = await checkAgentCLI(makeConfig("aider"));

    expect(result.passed).toBe(false);
    expect(result.message).toContain("aider");
  });
});

describe("checkAgentCLI — missing binary (non-zero exit)", () => {
  test("returns blocker when spawn exits non-zero", async () => {
    _deps.spawn = mock((_cmd: string[]) => ({
      exited: Promise.resolve(1),
      stdout: null,
      stderr: null,
    }));

    const result = await checkAgentCLI(makeConfig("claude"));

    expect(result.passed).toBe(false);
    expect(result.tier).toBe("blocker");
  });

  test("returns blocker when spawn throws ENOENT", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT");
    });

    const result = await checkAgentCLI(makeConfig("claude"));

    expect(result.passed).toBe(false);
    expect(result.tier).toBe("blocker");
  });

  test("check name is 'agent-cli-available'", async () => {
    _deps.spawn = mock((_cmd: string[]) => {
      throw new Error("ENOENT");
    });

    const result = await checkAgentCLI(makeConfig("codex"));

    expect(result.name).toBe("agent-cli-available");
  });
});

describe("checkAgentCLI — --version flag patterns", () => {
  test("invokes binary with --version flag", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("claude"));

    expect(calls[0]).toContain("--version");
  });

  test("aider uses --version flag", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("aider"));

    expect(calls[0]).toContain("--version");
  });

  test("codex uses --version flag", async () => {
    const calls: string[][] = [];
    _deps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    });

    await checkAgentCLI(makeConfig("codex"));

    expect(calls[0]).toContain("--version");
  });
});

describe("checkAgentCLI — no regression on checkClaudeCLI", () => {
  test("checkClaudeCLI still exists and works as before", async () => {
    const { checkClaudeCLI } = await import("../../../src/precheck/checks-blockers");

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
