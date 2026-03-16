/**
 * Tests for OpenCodeAdapter — MA-002
 *
 * Covers:
 * - AgentAdapter interface compliance (name, binary, displayName, capabilities)
 * - isInstalled() uses Bun.which('opencode') for binary detection
 * - complete() spawns opencode --prompt <text> for one-shot responses
 * - complete() throws CompleteError on non-zero exit or empty output
 * - getAgent('opencode') returns OpenCodeAdapter from registry
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenCodeAdapter, _opencodeCompleteDeps } from "../../../../src/agents/opencode/adapter";
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
    pid: 99999,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenCodeAdapter interface compliance", () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  test("name is 'opencode'", () => {
    expect(adapter.name).toBe("opencode");
  });

  test("binary is 'opencode'", () => {
    expect(adapter.binary).toBe("opencode");
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
  let adapter: OpenCodeAdapter;
  let originalWhich: (name: string) => string | null;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
    originalWhich = _opencodeCompleteDeps.which;
  });

  afterEach(() => {
    _opencodeCompleteDeps.which = originalWhich;
  });

  test("returns true when Bun.which finds the opencode binary", async () => {
    _opencodeCompleteDeps.which = (_name: string) => "/usr/local/bin/opencode";

    const result = await adapter.isInstalled();

    expect(result).toBe(true);
  });

  test("returns false when Bun.which returns null (binary not found)", async () => {
    _opencodeCompleteDeps.which = (_name: string) => null;

    const result = await adapter.isInstalled();

    expect(result).toBe(false);
  });

  test("calls Bun.which with 'opencode'", async () => {
    let capturedName = "";
    _opencodeCompleteDeps.which = (name: string) => {
      capturedName = name;
      return "/usr/local/bin/opencode";
    };

    await adapter.isInstalled();

    expect(capturedName).toBe("opencode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() — one-shot LLM call via _opencodeCompleteDeps
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  let adapter: OpenCodeAdapter;
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
    adapter = new OpenCodeAdapter();
    capturedCmd = [];
    originalSpawn = _opencodeCompleteDeps.spawn;
  });

  afterEach(() => {
    _opencodeCompleteDeps.spawn = originalSpawn;
  });

  // ── Success path ────────────────────────────────────────────────────────

  test("returns stdout text on success", async () => {
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("hello from opencode\n", 0);

    const result = await adapter.complete("say hello");

    expect(result).toContain("hello from opencode");
  });

  test("trims trailing whitespace from output", async () => {
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("  trimmed output  \n", 0);

    const result = await adapter.complete("test");

    expect(result).toBe("trimmed output");
  });

  // ── CLI command structure ───────────────────────────────────────────────

  test("spawns the opencode binary", async () => {
    _opencodeCompleteDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcessWithStdout("output", 0);
    };

    await adapter.complete("my prompt");

    expect(capturedCmd[0]).toBe("opencode");
  });

  test("includes --prompt flag and the prompt text", async () => {
    _opencodeCompleteDeps.spawn = (cmd, _opts) => {
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
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("error msg", 1);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("CompleteError includes the exit code on non-zero exit", async () => {
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 3);

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
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("throws CompleteError on whitespace-only stdout", async () => {
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("   \n  \t  ", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  // ── Return type ─────────────────────────────────────────────────────────

  test("complete returns a Promise", () => {
    _opencodeCompleteDeps.spawn = (_cmd, _opts) => mockProcessWithStdout("output", 0);

    const result = adapter.complete("test");
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry — getAgent('opencode') returns OpenCodeAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("adapter registry", () => {
  test("getAgent('opencode') returns an OpenCodeAdapter instance", () => {
    const adapter = getAgent("opencode");

    expect(adapter).toBeDefined();
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  test("returned adapter has name 'opencode'", () => {
    const adapter = getAgent("opencode");

    expect(adapter?.name).toBe("opencode");
  });

  test("returned adapter has binary 'opencode'", () => {
    const adapter = getAgent("opencode");

    expect(adapter?.binary).toBe("opencode");
  });
});
