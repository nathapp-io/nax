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
  test.each(["claude", "codex"] as const)("contains %s profile", (name) => {
    expect(name in AGENT_PROFILES).toBe(true);
  });

  test("claude >= 128_000 and codex >= 64_000 maxContextTokens", () => {
    expect(AGENT_PROFILES["claude"]!.caps.maxContextTokens).toBeGreaterThanOrEqual(128_000);
    expect(AGENT_PROFILES["codex"]!.caps.maxContextTokens).toBeGreaterThanOrEqual(64_000);
  });

  test.each([
    ["claude", "markdown-sections"],
    ["codex", "xml-tagged"],
  ] as const)("%s systemPromptStyle is %s", (name, style) => {
    expect(AGENT_PROFILES[name]!.caps.systemPromptStyle).toBe(style);
  });

  test.each([
    ["claude", "anthropic"],
    ["codex", "openai"],
  ] as const)("%s toolSchemaDialect is %s", (name, dialect) => {
    expect(AGENT_PROFILES[name]!.caps.toolSchemaDialect).toBe(dialect);
  });

  test("claude and codex supportsToolCalls is true", () => {
    expect(AGENT_PROFILES["claude"]!.caps.supportsToolCalls).toBe(true);
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
  test("has plain systemPromptStyle, none toolSchemaDialect, false supportsToolCalls, positive maxContextTokens", () => {
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.systemPromptStyle).toBe("plain");
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.toolSchemaDialect).toBe("none");
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.supportsToolCalls).toBe(false);
    expect(CONSERVATIVE_DEFAULT_PROFILE.caps.maxContextTokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAgentProfile
// ─────────────────────────────────────────────────────────────────────────────

describe("getAgentProfile", () => {
  test.each(["claude", "codex"] as const)("returns %s profile with isDefault: false", (name) => {
    const { profile, isDefault } = getAgentProfile(name);
    expect(profile).toBe(AGENT_PROFILES[name]);
    expect(isDefault).toBe(false);
  });

  test.each(["unknown-agent-xyz", ""] as const)("returns CONSERVATIVE_DEFAULT_PROFILE for '%s'", (id) => {
    const { profile, isDefault } = getAgentProfile(id);
    expect(profile).toBe(CONSERVATIVE_DEFAULT_PROFILE);
    expect(isDefault).toBe(true);
  });

  test("default profile has plain systemPromptStyle", () => {
    const { profile } = getAgentProfile("not-registered");
    expect(profile.caps.systemPromptStyle).toBe("plain");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-H6: AC-27 missing built-in profiles (gemini, cursor, local)
// ─────────────────────────────────────────────────────────────────────────────

describe("AGENT_PROFILES — #508-H6 AC-27 built-in profiles", () => {
  test.each(["gemini", "cursor", "local"] as const)("contains %s profile", (name) => {
    expect(name in AGENT_PROFILES).toBe(true);
  });

  test.each(["gemini", "cursor", "local"] as const)("getAgentProfile('%s') returns isDefault: false", (name) => {
    const { isDefault } = getAgentProfile(name);
    expect(isDefault).toBe(false);
  });

  test("gemini has positive maxContextTokens", () => {
    expect(AGENT_PROFILES["gemini"]?.caps.maxContextTokens).toBeGreaterThan(0);
  });

  test("local toolSchemaDialect is none and supportsToolCalls is false", () => {
    expect(AGENT_PROFILES["local"]?.caps.toolSchemaDialect).toBe("none");
    expect(AGENT_PROFILES["local"]?.caps.supportsToolCalls).toBe(false);
  });
});
