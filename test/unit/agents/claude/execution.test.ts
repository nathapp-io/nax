/**
 * Unit tests for src/agents/claude/execution.ts — BUG-076 HOME sanitization
 *
 * Tests buildAllowedEnv HOME sanitization:
 * - uses os.homedir() when HOME is "~" (unexpanded)
 * - uses os.homedir() when HOME is empty/unset
 * - uses the original HOME when it is already an absolute path
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { buildAllowedEnv } from "../../../../src/agents/claude/execution";
import type { AgentRunOptions } from "../../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalOptions(): AgentRunOptions {
  return {
    workdir: "/tmp",
    prompt: "test",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    timeoutSeconds: 60,
  } as AgentRunOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// BUG-076
describe("buildAllowedEnv — HOME is sanitized to an absolute path", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  test("uses the original HOME when it is an absolute path", () => {
    process.env.HOME = "/Users/testuser";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.HOME).toBe("/Users/testuser");
  });

  test("uses os.homedir() when HOME is literal ~", () => {
    process.env.HOME = "~";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.HOME).toBe(homedir());
    expect(env.HOME).not.toBe("~");
  });

  test("uses os.homedir() when HOME is empty string", () => {
    process.env.HOME = "";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.HOME).toBe(homedir());
  });

  test("uses os.homedir() when HOME is unset", () => {
    delete process.env.HOME;
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.HOME).toBe(homedir());
  });

  test("HOME in result is always an absolute path", () => {
    process.env.HOME = "~";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.HOME).toBeDefined();
    expect(env.HOME!.startsWith("/")).toBe(true);
  });
});

describe("buildAllowedEnv — ANTHROPIC_ prefix passthrough", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env (remove any test-only vars)
    for (const key of Object.keys(process.env)) {
      if (!originalEnv[key]) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
  });

  test("passes ANTHROPIC_AUTH_TOKEN through when set", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "minimax-test-key";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("minimax-test-key");
  });

  test("passes ANTHROPIC_BASE_URL through when set", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
  });

  test("passes all ANTHROPIC_* vars through via prefix match", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "key1";
    process.env.ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
    process.env.ANTHROPIC_MODEL = "MiniMax-M2.7";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "MiniMax-M2.7";
    process.env.ANTHROPIC_SMALL_FAST_MODEL = "MiniMax-M2.7";
    process.env.ANTHROPIC_API_KEY = "should-also-pass";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("key1");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.7");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("MiniMax-M2.7");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("MiniMax-M2.7");
    expect(env.ANTHROPIC_API_KEY).toBe("should-also-pass");
  });

  test("does not pass unrelated vars", () => {
    process.env.SOME_random_VAR = "should-not-pass";
    process.env.MY_CUSTOM_KEY = "also-no";
    const env = buildAllowedEnv(makeMinimalOptions());
    expect(env.SOME_random_VAR).toBeUndefined();
    expect(env.MY_CUSTOM_KEY).toBeUndefined();
  });
});
