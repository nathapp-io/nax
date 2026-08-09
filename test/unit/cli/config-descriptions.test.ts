/**
 * Configuration Field Descriptions Tests
 *
 * Verifies that config-descriptions.ts descriptions accurately reflect
 * the per-agent model map shape introduced in US-001-4.
 */

import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli";
import { RoutingConfigSchema } from "@/config";

describe("FIELD_DESCRIPTIONS routing coherence with RoutingConfigSchema", () => {
  test("documents no routing key the schema does not define", () => {
    const schemaKeys = Object.keys(RoutingConfigSchema.shape);
    const documented = [
      ...new Set(
        Object.keys(FIELD_DESCRIPTIONS)
          .filter((k) => k.startsWith("routing."))
          .map((k) => k.slice("routing.".length).split(".")[0]),
      ),
    ];

    expect(documented.filter((k) => !schemaKeys.includes(k))).toEqual([]);
  });

  test("routing.strategy description names only the strategies the schema accepts", () => {
    const description = FIELD_DESCRIPTIONS["routing.strategy"];

    for (const removed of ["manual", "adaptive", "custom"]) {
      expect(description).not.toContain(removed);
    }
  });
});

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

describe("FIELD_DESCRIPTIONS.execution.mutationCheck", () => {
  const KEYS = [
    "execution.mutationCheck",
    "execution.mutationCheck.enabled",
    "execution.mutationCheck.maxMutants",
    "execution.mutationCheck.timeoutSeconds",
  ];

  test.each(KEYS)("%s has a non-empty description", (key) => {
    expect(typeof FIELD_DESCRIPTIONS[key]).toBe("string");
    expect(FIELD_DESCRIPTIONS[key].length).toBeGreaterThan(0);
  });

  test("the parent description states the check is advisory", () => {
    expect(FIELD_DESCRIPTIONS["execution.mutationCheck"].toLowerCase()).toContain("advisory");
  });

  test("enabled description records the opt-in default", () => {
    expect(FIELD_DESCRIPTIONS["execution.mutationCheck.enabled"]).toContain("false");
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
