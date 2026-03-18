/**
 * Tests for ClaudeCodeAdapter.complete() — one-shot LLM call
 *
 * Covers: AA-001
 * - AgentAdapter interface has complete(prompt, options?): Promise<string>
 * - ClaudeAdapter implements complete() using Bun.spawn(['claude', '-p', prompt, ...flags])
 * - jsonMode adds --output-format json flag
 * - model option passes --model flag
 * - maxTokens option is accepted but NOT forwarded (Claude Code CLI doesn't support --max-tokens)
 * - Non-zero exit throws CompleteError
 * - Empty output throws CompleteError
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClaudeCodeAdapter, _completeDeps } from "../../../src/agents/claude";
import { CompleteError } from "../../../src/agents/types";
import type { CompleteOptions } from "../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Mock process factory
// Creates a minimal fake Bun.spawn result for use in _completeDeps overrides.
// ─────────────────────────────────────────────────────────────────────────────

function mockProcess(stdoutText: string, exitCode: number) {
  const body = new Response(stdoutText).body as ReadableStream<Uint8Array>;
  return {
    stdout: body,
    exited: Promise.resolve(exitCode),
    pid: 99999,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  let adapter: ClaudeCodeAdapter;
  let capturedCmd: string[];
  const origSpawn = _completeDeps.spawn;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    capturedCmd = [];
  });

  afterEach(() => {
    _completeDeps.spawn = origSpawn;
  });

  // ── Success path ────────────────────────────────────────────────────────

  test("returns stdout text on success", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("hello from claude\n", 0);
    };

    const result = await adapter.complete("say hello");

    expect(result).toContain("hello from claude");
  });

  test("trims trailing whitespace from output", async () => {
    _completeDeps.spawn = (_cmd, _opts) => mockProcess("  trimmed output  \n", 0);

    const result = await adapter.complete("test");

    expect(result).toBe("trimmed output");
  });

  // ── CLI command structure ───────────────────────────────────────────────

  test("calls the claude binary", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("my prompt");

    expect(capturedCmd[0]).toBe("claude");
  });

  test("includes -p flag and the prompt in command", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("my test prompt");

    const pIdx = capturedCmd.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(capturedCmd[pIdx + 1]).toBe("my test prompt");
  });

  // ── jsonMode option ─────────────────────────────────────────────────────

  test("jsonMode adds --output-format json flag", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("{}", 0);
    };

    await adapter.complete("return json", { jsonMode: true } satisfies CompleteOptions);

    const fmtIdx = capturedCmd.indexOf("--output-format");
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(capturedCmd[fmtIdx + 1]).toBe("json");
  });

  test("without jsonMode, --output-format is not present", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("plain text", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).not.toContain("--output-format");
  });

  // ── model option ────────────────────────────────────────────────────────

  test("model option passes --model flag with value", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("test", { model: "claude-opus-4-6" } satisfies CompleteOptions);

    const modelIdx = capturedCmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedCmd[modelIdx + 1]).toBe("claude-opus-4-6");
  });

  test("without model option, --model flag is absent", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).not.toContain("--model");
  });

  // ── maxTokens option ────────────────────────────────────────────────────
  // Note: Claude Code CLI does not support --max-tokens. The option is accepted in
  // CompleteOptions for future use / other adapters, but is NOT forwarded to the binary.

  test("maxTokens option does NOT pass --max-tokens flag (unsupported by Claude Code CLI)", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("test", { maxTokens: 1024 } satisfies CompleteOptions);

    expect(capturedCmd).not.toContain("--max-tokens");
  });

  test("without maxTokens, --max-tokens flag is absent", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("output", 0);
    };

    await adapter.complete("test");

    expect(capturedCmd).not.toContain("--max-tokens");
  });

  // ── All options combined ────────────────────────────────────────────────

  test("all options can be combined in a single call", async () => {
    _completeDeps.spawn = (cmd, _opts) => {
      capturedCmd = cmd;
      return mockProcess("{}", 0);
    };

    const options: CompleteOptions = { jsonMode: true, model: "claude-haiku-4-5-20251001", maxTokens: 512 };
    await adapter.complete("multi-option test", options);

    expect(capturedCmd).toContain("--output-format");
    expect(capturedCmd).toContain("json");
    expect(capturedCmd).toContain("--model");
    expect(capturedCmd).toContain("claude-haiku-4-5-20251001");
    // maxTokens is accepted in options but not forwarded to Claude Code CLI (unsupported flag)
    expect(capturedCmd).not.toContain("--max-tokens");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  test("throws CompleteError on non-zero exit code", async () => {
    _completeDeps.spawn = (_cmd, _opts) => mockProcess("some output", 1);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("error on non-zero exit includes exit code", async () => {
    _completeDeps.spawn = (_cmd, _opts) => mockProcess("output", 2);

    let caught: unknown;
    try {
      await adapter.complete("test");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CompleteError);
    const err = caught as CompleteError;
    expect(err.exitCode === 2 || err.message.includes("2")).toBe(true);
  });

  test("throws CompleteError on empty stdout", async () => {
    _completeDeps.spawn = (_cmd, _opts) => mockProcess("", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

  test("throws CompleteError on whitespace-only stdout", async () => {
    _completeDeps.spawn = (_cmd, _opts) => mockProcess("   \n  \t  ", 0);

    await expect(adapter.complete("test")).rejects.toThrow(CompleteError);
  });

});
