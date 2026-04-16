/**
 * agent-profiles.ts — unit tests
 *
 * Covers AGENT_PROFILES registry, CONSERVATIVE_DEFAULT_PROFILE,
 * and getAgentProfile() lookup with known and unknown agent ids.
 */

import { describe, test, expect } from "bun:test";
import {
  AGENT_PROFILES,
  CONSERVATIVE_DEFAULT_PROFILE,
  getAgentProfile,
} from "../../../../src/context/engine/agent-profiles";

// ─────────────────────────────────────────────────────────────────────────────
// AGENT_PROFILES registry
// ─────────────────────────────────────────────────────────────────────────────

describe("AGENT_PROFILES", () => {
  test("contains claude profile", () => {
    expect("claude" in AGENT_PROFILES).toBe(true);
  });

  test("contains codex profile", () => {
    expect("codex" in AGENT_PROFILES).toBe(true);
  });

  test("claude caps have maxContextTokens >= 128_000", () => {
    expect(AGENT_PROFILES["claude"]!.caps.maxContextTokens).toBeGreaterThanOrEqual(128_000);
  });

  test("codex caps have maxContextTokens >= 64_000", () => {
    expect(AGENT_PROFILES["codex"]!.caps.maxContextTokens).toBeGreaterThanOrEqual(64_000);
  });

  test("claude systemPromptStyle is markdown-sections", () => {
    expect(AGENT_PROFILES["claude"]!.caps.systemPromptStyle).toBe("markdown-sections");
  });

  test("codex systemPromptStyle is xml-tagged", () => {
    expect(AGENT_PROFILES["codex"]!.caps.systemPromptStyle).toBe("xml-tagged");
  });

  test("claude toolSchemaDialect is anthropic", () => {
    expect(AGENT_PROFILES["claude"]!.caps.toolSchemaDialect).toBe("anthropic");
  });

  test("codex toolSchemaDialect is openai", () => {
    expect(AGENT_PROFILES["codex"]!.caps.toolSchemaDialect).toBe("openai");
  });

  test("claude supportsToolCalls is true", () => {
    expect(AGENT_PROFILES["claude"]!.caps.supportsToolCalls).toBe(true);
  });

  test("codex supportsToolCalls is true", () => {
    expect(AGENT_PROFILES["codex"]!.caps.supportsToolCalls).toBe(true);
  });

  test("all profiles have preferredPromptTokens > 0", () => {
    for (const [, profile] of Object.entries(AGENT_PROFILES)) {
      expect(profile.caps.preferredPromptTokens).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSERVATIVE_DEFAULT_PROFILE
// ─────────────────────────────────────────────────────────────────────────────

describe("CONSERVATIVE_DEFAULT_PROFILE", () => {
  test("systemPromptStyle is plain", () => {
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.systemPromptStyle).toBe("plain");
  });

  test("toolSchemaDialect is none", () => {
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.toolSchemaDialect).toBe("none");
  });

  test("supportsToolCalls is false", () => {
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.supportsToolCalls).toBe(false);
  });

  test("has positive maxContextTokens", () => {
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.maxContextTokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAgentProfile
// ─────────────────────────────────────────────────────────────────────────────

describe("getAgentProfile", () => {
  test("returns claude profile with isDefault: false", () => {
    const { profile, isDefault } = getAgentProfile("claude");
    expect(profile).toBe(AGENT_PROFILES["claude"]);
    expect(isDefault).toBe(false);
  });

  test("returns codex profile with isDefault: false", () => {
    const { profile, isDefault } = getAgentProfile("codex");
    expect(profile).toBe(AGENT_PROFILES["codex"]);
    expect(isDefault).toBe(false);
  });

  test("returns CONSERVATIVE_DEFAULT_PROFILE for unknown agent", () => {
    const { profile, isDefault } = getAgentProfile("unknown-agent-xyz");
    expect(profile).toBe(CONSERVATIVE_DEFAULT_PROFILE);
    expect(isDefault).toBe(true);
  });

  test("returns CONSERVATIVE_DEFAULT_PROFILE for empty string", () => {
    const { profile, isDefault } = getAgentProfile("");
    expect(profile).toBe(CONSERVATIVE_DEFAULT_PROFILE);
    expect(isDefault).toBe(true);
  });

  test("default profile has plain systemPromptStyle", () => {
    const { profile } = getAgentProfile("not-registered");
    expect(profile.caps.systemPromptStyle).toBe("plain");
  });
});
