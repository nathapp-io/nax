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

describe("buildAllowedEnv — HOME sanitization (BUG-076)", () => {
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
