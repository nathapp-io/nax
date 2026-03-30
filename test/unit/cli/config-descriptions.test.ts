/**
 * Configuration Field Descriptions Tests
 *
 * Verifies that config-descriptions.ts descriptions accurately reflect
 * the per-agent model map shape introduced in US-001-4.
 */

import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";

describe("FIELD_DESCRIPTIONS.models (US-001-4)", () => {
  test("models description exists", () => {
    expect(FIELD_DESCRIPTIONS.models).toBeDefined();
  });

  test("models description mentions per-agent map shape", () => {
    expect(FIELD_DESCRIPTIONS.models.toLowerCase()).toContain("per-agent");
  });

  test("models description does not reference deprecated flat tier structure", () => {
    // Should not say "fast/balanced/powerful" as top-level keys
    const desc = FIELD_DESCRIPTIONS.models;
    expect(desc).not.toMatch(/^.*fast.*balanced.*powerful$/i);
  });
});

describe("FIELD_DESCRIPTIONS.autoMode.fallbackOrder (US-001-4)", () => {
  test("fallbackOrder description exists", () => {
    expect(FIELD_DESCRIPTIONS["autoMode.fallbackOrder"]).toBeDefined();
  });

  test("fallbackOrder description mentions per-agent shape", () => {
    expect(FIELD_DESCRIPTIONS["autoMode.fallbackOrder"].toLowerCase()).toContain("per-agent");
  });
});

describe("FIELD_DESCRIPTIONS structure for per-agent models", () => {
  test("models.claude description exists for agent tier definitions", () => {
    expect(FIELD_DESCRIPTIONS["models.claude"]).toBeDefined();
  });

  test("per-agent tier descriptions are present (e.g., models.claude.fast)", () => {
    // Descriptions for agent-specific tiers
    expect(FIELD_DESCRIPTIONS["models.claude.fast"]).toBeDefined();
    expect(FIELD_DESCRIPTIONS["models.claude.balanced"]).toBeDefined();
    expect(FIELD_DESCRIPTIONS["models.claude.powerful"]).toBeDefined();
  });
});
