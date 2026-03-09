/**
 * Tests for GeminiAdapter — MA-003
 *
 * Covers:
 * - AgentAdapter interface compliance (name, binary, displayName, capabilities)
 * - isInstalled() uses Bun.which('gemini') for binary detection
 * - complete() spawns gemini -p <text> for one-shot responses
 * - complete() throws CompleteError on non-zero exit or empty output
 * - getAgent('gemini') returns GeminiAdapter from registry
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GeminiAdapter, _geminiCompleteDeps } from "../../../../src/agents/adapters/gemini";
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
    pid: 77777,
  };
}

function mockProcessWithStderr(stderrText: string, exitCode: number) {
  return {
    stdout: new Response("").body as ReadableStream<Uint8Array>,
    stderr: new Response(stderrText).body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(exitCode),
    pid: 77777,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("GeminiAdapter interface compliance", () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
  });

  test("name is 'gemini'", () => {
    expect(adapter.name).toBe("gemini");
  });

  test("binary is 'gemini'", () => {
    expect(adapter.binary).toBe("gemini");
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
  let adapter: GeminiAdapter;
  let originalWhich: (name: string) => string | null;

  beforeEach(() => {
    adapter = new GeminiAdapter();
    originalWhich = _geminiCompleteDeps.which;
  });

  afterEach(() => {
    _geminiCompleteDeps.which = originalWhich;
  });

  test("returns true when Bun.which finds the gemini binary", async () => {
    _geminiCompleteDeps.which = (_name: string) => "/usr/local/bin/gemini";

    const result = await adapter.isInstalled();

    expect(result).toBe(true);
  });

  test("returns false when Bun.which returns null (binary not found)", async () => {
    _geminiCompleteDeps.which = (_name: string) => null;

    const result = await adapter.isInstalled();

    expect(result).toBe(false);
  });

  test("calls Bun.which with 'gemini'", async () => {
    let capturedName = "";
    _geminiCompleteDeps.which = (name: string) => {
      capturedName = name;
      return "/usr/local/bin/gemini";
    };

    await adapter.isInstalled();

    expect(capturedName).toBe("gemini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — one-shot LLM call via _geminiCompleteDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  let adapter: GeminiAdapter;
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
    adapter = new GeminiAdapter();
    capturedCmd = [];
    originalSpawn = _geminiCompleteDeps.spawn;
  });

  afterEach(() => {
    _geminiCompleteDeps.spawn = originalSpawn;
  });

  // ── Success path ────────────────────────────────────────────────────────

  test("returns stdout text on success", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("hello from gemini\n", 0);

    const result = await adapter.complete("say hello");

    expect(result).toContain("hello from gemini");
  });

  test("trims trailing whitespace from output", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("  trimmed output  \n", 0);

    const result = await adapter.complete("test");

    expect(result).toBe("trimmed output");
  });

  // ── CLI command structure ───────────────────────────────────────────────

  test("spawns the gemini binary", async () => {
    _geminiCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my prompt");

    expect(capturedCmd[0]).toBe("gemini");
  });

  test("includes -p flag for one-shot mode", async () => {
    _geminiCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).toContain("-p");
  });

  test("-p flag is followed by the prompt text", async () => {
    _geminiCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my test prompt");

    const pIdx = capturedCmd.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(capturedCmd[pIdx + 1]).toBe("my test prompt");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  test("throws CompleteError on non-zero exit code", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("error msg", 1);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("CompleteError includes the exit code on non-zero exit", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 3);

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
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("throws CompleteError on whitespace-only stdout", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("   \n  \t  ", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("uses stderr message when stdout is empty and exit code non-zero", async () => {
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStderr("stderr error message", 1);

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
    _geminiCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 0);

    const result = adapter.complete("test");
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry — getAgent('gemini') returns GeminiAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("adapter registry", () => {
  test("getAgent('gemini') returns a GeminiAdapter instance", () => {
    const adapter = getAgent("gemini");

    expect(adapter).toBeDefined();
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  test("returned adapter has name 'gemini'", () => {
    const adapter = getAgent("gemini");

    expect(adapter?.name).toBe("gemini");
  });

  test("returned adapter has binary 'gemini'", () => {
    const adapter = getAgent("gemini");

    expect(adapter?.binary).toBe("gemini");
  });
});
