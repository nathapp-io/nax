/**
 * Tests for AiderAdapter — MA-004
 *
 * Covers:
 * - AgentAdapter interface compliance (name, binary, displayName, capabilities)
 * - isInstalled() uses Bun.which('aider') for binary detection
 * - complete() spawns aider --message --yes <text> for headless mode
 * - --model flag passthrough when specified in options
 * - complete() throws CompleteError on non-zero exit or empty output
 * - getAgent('aider') returns AiderAdapter from registry
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AiderAdapter, _aiderCompleteDeps } from "../../../../src/agents/adapters/aider";
import { getAgent } from "../../../../src/agents/registry";
import { CompleteError } from "../../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Mock process factories
// ─────────────────────────────────────────────────────────────────────────────

function mockProcessWithStdout(stdoutText: string, exitCode: number) {
  const body = new Response(stdoutText).body as ReadableStream<Uint8Array>;
  return {
    stdout: body,
    stderr: new Response("").body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(exitCode),
    pid: 66666,
  };
}

function mockProcessWithStderr(stderrText: string, exitCode: number) {
  return {
    stdout: new Response("").body as ReadableStream<Uint8Array>,
    stderr: new Response(stderrText).body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(exitCode),
    pid: 66666,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("AiderAdapter interface compliance", () => {
  let adapter: AiderAdapter;

  beforeEach(() => {
    adapter = new AiderAdapter();
  });

  test("name is 'aider'", () => {
    expect(adapter.name).toBe("aider");
  });

  test("binary is 'aider'", () => {
    expect(adapter.binary).toBe("aider");
  });

  test("displayName is a non-empty string", () => {
    expect(typeof adapter.displayName).toBe("string");
    expect(adapter.displayName.length).toBeGreaterThan(0);
  });

  test("capabilities.supportedTiers is a non-empty array", () => {
    expect(Array.isArray(adapter.capabilities.supportedTiers)).toBe(true);
    expect(adapter.capabilities.supportedTiers.length).toBeGreaterThan(0);
  });

  test("capabilities.features is a Set", () => {
    expect(adapter.capabilities.features).toBeInstanceOf(Set);
  });

  test("capabilities.maxContextTokens is a positive number", () => {
    expect(adapter.capabilities.maxContextTokens).toBeGreaterThan(0);
  });

  test("isInstalled is a function", () => {
    expect(typeof adapter.isInstalled).toBe("function");
  });

  test("complete is a function", () => {
    expect(typeof adapter.complete).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isInstalled() — Bun.which binary detection
// ─────────────────────────────────────────────────────────────────────────────

describe("isInstalled()", () => {
  let adapter: AiderAdapter;
  let originalWhich: (name: string) => string | null;

  beforeEach(() => {
    adapter = new AiderAdapter();
    originalWhich = _aiderCompleteDeps.which;
  });

  afterEach(() => {
    _aiderCompleteDeps.which = originalWhich;
  });

  test("returns true when Bun.which finds the aider binary", async () => {
    _aiderCompleteDeps.which = (_name: string) => "/usr/local/bin/aider";

    const result = await adapter.isInstalled();

    expect(result).toBe(true);
  });

  test("returns false when Bun.which returns null (binary not found)", async () => {
    _aiderCompleteDeps.which = (_name: string) => null;

    const result = await adapter.isInstalled();

    expect(result).toBe(false);
  });

  test("calls Bun.which with 'aider'", async () => {
    let capturedName = "";
    _aiderCompleteDeps.which = (name: string) => {
      capturedName = name;
      return "/usr/local/bin/aider";
    };

    await adapter.isInstalled();

    expect(capturedName).toBe("aider");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — one-shot LLM call via _aiderCompleteDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  let adapter: AiderAdapter;
  let capturedCmd: string[];
  let originalSpawn: (
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" | "inherit" },
  ) => {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
  };

  beforeEach(() => {
    adapter = new AiderAdapter();
    capturedCmd = [];
    originalSpawn = _aiderCompleteDeps.spawn;
  });

  afterEach(() => {
    _aiderCompleteDeps.spawn = originalSpawn;
  });

  // ── Success path ────────────────────────────────────────────────────────

  test("returns stdout text on success", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("hello from aider\n", 0);

    const result = await adapter.complete("say hello");

    expect(result).toContain("hello from aider");
  });

  test("trims trailing whitespace from output", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("  trimmed output  \n", 0);

    const result = await adapter.complete("test");

    expect(result).toBe("trimmed output");
  });

  // ── CLI command structure ───────────────────────────────────────────────

  test("spawns the aider binary", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my prompt");

    expect(capturedCmd[0]).toBe("aider");
  });

  test("includes --message flag for headless mode", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).toContain("--message");
  });

  test("includes --yes flag for headless mode", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).toContain("--yes");
  });

  test("--message flag is followed by the prompt text", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my test prompt");

    const msgIdx = capturedCmd.indexOf("--message");
    expect(msgIdx).toBeGreaterThan(-1);
    expect(capturedCmd[msgIdx + 1]).toBe("my test prompt");
  });

  test("does not include --model flag when not specified in options", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).not.toContain("--model");
  });

  test("includes --model flag when specified in options", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test", { model: "gpt-4" });

    expect(capturedCmd).toContain("--model");
  });

  test("--model flag is followed by the model name", async () => {
    _aiderCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test", { model: "gpt-4-turbo" });

    const modelIdx = capturedCmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedCmd[modelIdx + 1]).toBe("gpt-4-turbo");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  test("throws CompleteError on non-zero exit code", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("error msg", 1);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("CompleteError includes the exit code on non-zero exit", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 3);

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
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("throws CompleteError on whitespace-only stdout", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("   \n  \t  ", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("uses stderr message when stdout is empty and exit code non-zero", async () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStderr("stderr error message", 1);

    let caught: unknown;
    try {
      await adapter.complete("test");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CompleteError);
    const err = caught as CompleteError;
    expect(err.message).toContain("stderr error message");
  });

  // ── Return type ─────────────────────────────────────────────────────────

  test("complete returns a Promise", () => {
    _aiderCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 0);

    const result = adapter.complete("test");
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry — getAgent('aider') returns AiderAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("adapter registry", () => {
  test("getAgent('aider') returns an AiderAdapter instance", () => {
    const adapter = getAgent("aider");

    expect(adapter).toBeDefined();
    expect(adapter).toBeInstanceOf(AiderAdapter);
  });

  test("returned adapter has name 'aider'", () => {
    const adapter = getAgent("aider");

    expect(adapter?.name).toBe("aider");
  });

  test("returned adapter has binary 'aider'", () => {
    const adapter = getAgent("aider");

    expect(adapter?.binary).toBe("aider");
  });
});
