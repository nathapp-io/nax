/**
 * Tests for CodexAdapter — AA-007
 *
 * Covers:
 * - AgentAdapter interface compliance (name, binary, displayName, capabilities)
 * - isInstalled() uses Bun.which('codex') for binary detection
 * - run() spawns codex -q --prompt <text> for headless sessions
 * - buildCommand() returns correct argv including -q and --prompt
 * - complete() spawns codex -q --prompt for one-shot responses
 * - complete() throws CompleteError on non-zero exit or empty output
 * - getAgent('codex') returns CodexAdapter from registry
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CodexAdapter, _codexCompleteDeps, _codexRunDeps } from "../../../../src/agents/codex/adapter";
import { CompleteError } from "../../../../src/agents/types";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { getAgent } from "../../../../src/agents/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Mock process factories
// ─────────────────────────────────────────────────────────────────────────────

function mockProcessWithStdout(stdoutText: string, exitCode: number) {
  const body = new Response(stdoutText).body as ReadableStream<Uint8Array>;
  return {
    stdout: body,
    stderr: new Response("").body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(exitCode),
    pid: 88888,
    kill: (_signal?: number | NodeJS.Signals) => {},
  };
}

function makeRunOptions(workdir: string): AgentRunOptions {
  return {
    workdir,
    prompt: "write a hello world function",
    modelTier: "balanced",
    modelDef: { provider: "openai", model: "codex-mini", env: {} },
    timeoutSeconds: 60,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("CodexAdapter interface compliance", () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  test("name is 'codex'", () => {
    expect(adapter.name).toBe("codex");
  });

  test("binary is 'codex'", () => {
    expect(adapter.binary).toBe("codex");
  });

  test("capabilities.supportedTiers is a non-empty array", () => {
    expect(Array.isArray(adapter.capabilities.supportedTiers)).toBe(true);
    expect(adapter.capabilities.supportedTiers.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isInstalled() — Bun.which binary detection
// ─────────────────────────────────────────────────────────────────────────────

describe("isInstalled()", () => {
  let adapter: CodexAdapter;
  const origWhich = _codexRunDeps.which;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  afterEach(() => {
    _codexRunDeps.which = origWhich;
  });

  test("returns true when Bun.which finds the codex binary", async () => {
    _codexRunDeps.which = (_name: string) => "/usr/local/bin/codex";

    const result = await adapter.isInstalled();

    expect(result).toBe(true);
  });

  test("returns false when Bun.which returns null (binary not found)", async () => {
    _codexRunDeps.which = (_name: string) => null;

    const result = await adapter.isInstalled();

    expect(result).toBe(false);
  });

  test("calls Bun.which with 'codex'", async () => {
    let capturedName = "";
    _codexRunDeps.which = (name: string) => {
      capturedName = name;
      return "/usr/local/bin/codex";
    };

    await adapter.isInstalled();

    expect(capturedName).toBe("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCommand() — CLI argv structure for headless sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCommand()", () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  test("first element is 'codex'", () => {
    const opts = makeRunOptions("/tmp/test");
    const cmd = adapter.buildCommand(opts);

    expect(cmd[0]).toBe("codex");
  });

  test("includes -q flag for quiet/headless mode", () => {
    const opts = makeRunOptions("/tmp/test");
    const cmd = adapter.buildCommand(opts);

    expect(cmd).toContain("-q");
  });

  test("includes --prompt flag", () => {
    const opts = makeRunOptions("/tmp/test");
    const cmd = adapter.buildCommand(opts);

    expect(cmd).toContain("--prompt");
  });

  test("--prompt flag is followed by the prompt text", () => {
    const opts = makeRunOptions("/tmp/test");
    opts.prompt = "implement feature X";
    const cmd = adapter.buildCommand(opts);

    const promptIdx = cmd.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(cmd[promptIdx + 1]).toBe("implement feature X");
  });

  test("returns an array of strings", () => {
    const opts = makeRunOptions("/tmp/test");
    const cmd = adapter.buildCommand(opts);

    expect(Array.isArray(cmd)).toBe(true);
    for (const arg of cmd) {
      expect(typeof arg).toBe("string");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — headless agent execution via _codexRunDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("run()", () => {
  let adapter: CodexAdapter;
  let capturedCmd: string[];
  const origSpawn = _codexRunDeps.spawn;

  beforeEach(() => {
    adapter = new CodexAdapter();
    capturedCmd = [];
  });

  afterEach(() => {
    _codexRunDeps.spawn = origSpawn;
  });

  test("spawns the codex binary", async () => {
    _codexRunDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("done\n", 0);
    };

    await adapter.run(makeRunOptions("/tmp/test"));

    expect(capturedCmd[0]).toBe("codex");
  });

  test("passes -q flag to the spawned process", async () => {
    _codexRunDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("done\n", 0);
    };

    await adapter.run(makeRunOptions("/tmp/test"));

    expect(capturedCmd).toContain("-q");
  });

  test("passes --prompt flag with the prompt text", async () => {
    _codexRunDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("done\n", 0);
    };

    const opts = makeRunOptions("/tmp/test");
    opts.prompt = "add unit tests";
    await adapter.run(opts);

    const promptIdx = capturedCmd.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(capturedCmd[promptIdx + 1]).toBe("add unit tests");
  });

  test("returns success: true on exit code 0", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("all done\n", 0);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(result.success).toBe(true);
  });

  test("returns success: false on non-zero exit code", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("error output\n", 1);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(result.success).toBe(false);
  });

  test("result includes exitCode matching the process exit code", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output\n", 42);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(result.exitCode).toBe(42);
  });

  test("result includes output from stdout", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("task completed successfully\n", 0);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(result.output).toContain("task completed successfully");
  });

  test("result includes durationMs as a non-negative number", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("ok\n", 0);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("result includes estimatedCost as a non-negative number", async () => {
    _codexRunDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("ok\n", 0);

    const result = await adapter.run(makeRunOptions("/tmp/test"));

    expect(typeof result.estimatedCost).toBe("number");
    expect(result.estimatedCost).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — one-shot LLM call via _codexCompleteDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  let adapter: CodexAdapter;
  let capturedCmd: string[];
  const origSpawn = _codexCompleteDeps.spawn;

  beforeEach(() => {
    adapter = new CodexAdapter();
    capturedCmd = [];
  });

  afterEach(() => {
    _codexCompleteDeps.spawn = origSpawn;
  });

  // ── Success path ────────────────────────────────────────────────────────

  test("returns stdout text on success", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("hello from codex\n", 0);

    const result = await adapter.complete("say hello");

    expect(result.output).toContain("hello from codex");
  });

  test("trims trailing whitespace from output", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("  trimmed output  \n", 0);

    const result = await adapter.complete("test");

    expect(result.output).toBe("trimmed output");
  });

  // ── CLI command structure ───────────────────────────────────────────────

  test("spawns the codex binary", async () => {
    _codexCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my prompt");

    expect(capturedCmd[0]).toBe("codex");
  });

  test("includes -q flag for quiet/headless mode", async () => {
    _codexCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).toContain("-q");
  });

  test("includes --prompt flag and the prompt text", async () => {
    _codexCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my test prompt");

    const promptIdx = capturedCmd.indexOf("--prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(capturedCmd[promptIdx + 1]).toBe("my test prompt");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  test("throws CompleteError on non-zero exit code", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("error msg", 1);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("CompleteError includes the exit code on non-zero exit", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 3);

    let caught: unknown;
    try {
      await adapter.complete("test");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CompleteError);
    const err = caught as CompleteError;
    expect(err.exitCode === 3 || err.message.includes("3")).toBe(true);
  });

  test("throws CompleteError on empty stdout with exit code 0", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("throws CompleteError on whitespace-only stdout", async () => {
    _codexCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("   \n  \t  ", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Registry — getAgent('codex') returns CodexAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("adapter registry", () => {
  test("getAgent('codex') returns a CodexAdapter instance", () => {
    const adapter = getAgent("codex");

    expect(adapter).toBeDefined();
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  test("returned adapter has name 'codex'", () => {
    const adapter = getAgent("codex");

    expect(adapter?.name).toBe("codex");
  });

  test("returned adapter has binary 'codex'", () => {
    const adapter = getAgent("codex");

    expect(adapter?.binary).toBe("codex");
  });
});
