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


describe("FIELD_DESCRIPTIONS.precheck.storySizeGate action and maxReplanAttempts (US-001)", () => {
  test("precheck.storySizeGate.action description exists", () => {
    expect(FIELD_DESCRIPTIONS["precheck.storySizeGate.action"]).toBeDefined();
  });

  test("precheck.storySizeGate.action description is a non-empty string", () => {
    expect(typeof FIELD_DESCRIPTIONS["precheck.storySizeGate.action"]).toBe("string");
    expect(FIELD_DESCRIPTIONS["precheck.storySizeGate.action"].length).toBeGreaterThan(0);
  });

  test("precheck.storySizeGate.maxReplanAttempts description exists", () => {
    expect(FIELD_DESCRIPTIONS["precheck.storySizeGate.maxReplanAttempts"]).toBeDefined();
  });

  test("precheck.storySizeGate.maxReplanAttempts description is a non-empty string", () => {
    expect(typeof FIELD_DESCRIPTIONS["precheck.storySizeGate.maxReplanAttempts"]).toBe("string");
    expect(FIELD_DESCRIPTIONS["precheck.storySizeGate.maxReplanAttempts"].length).toBeGreaterThan(0);
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
