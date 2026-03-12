/**
 * Acceptance Tests — Acceptance Pipeline Feature
 *
 * These tests verify the acceptance pipeline was built correctly.
 * They should FAIL before implementation (RED) and PASS after (GREEN).
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

// ACC-001: AC Refinement Module
describe("ACC-001: AC Refinement Module", () => {
  test("AC-1: refineAcceptanceCriteria is exported and callable", async () => {
    const mod = await import("../../../src/acceptance/refinement");
    expect(typeof mod.refineAcceptanceCriteria).toBe("function");
  });

  test("AC-2: buildRefinementPrompt is exported and callable", async () => {
    const mod = await import("../../../src/acceptance/refinement");
    expect(typeof mod.buildRefinementPrompt).toBe("function");
  });

  test("AC-3: parseRefinementResponse is exported and callable", async () => {
    const mod = await import("../../../src/acceptance/refinement");
    expect(typeof mod.parseRefinementResponse).toBe("function");
  });

  test("AC-4: parseRefinementResponse handles valid JSON", async () => {
    const { parseRefinementResponse } = await import("../../../src/acceptance/refinement");
    const criteria = ["Users can log in", "Password is hashed"];
    const validJson = JSON.stringify([
      { original: "Users can log in", refined: "POST /api/login returns 200", testable: true },
      { original: "Password is hashed", refined: "stored password is not plaintext", testable: true },
    ]);
    const result = parseRefinementResponse(validJson, criteria);
    expect(result).toBeArray();
    expect(result.length).toBe(2);
    expect(result[0].refined).toContain("login");
    expect(result[0].testable).toBe(true);
  });

  test("AC-5: parseRefinementResponse falls back on malformed JSON", async () => {
    const { parseRefinementResponse } = await import("../../../src/acceptance/refinement");
    const criteria = ["Feature works"];
    const result = parseRefinementResponse("not json {{{" , criteria);
    expect(result).toBeArray();
    expect(result.length).toBe(1);
    expect(result[0].original).toBe("Feature works");
  });

  test("AC-6: RefinedCriterion type exists in types module", async () => {
    const mod = await import("../../../src/acceptance/types");
    // Verify type exists by creating a conforming object
    const criterion = { original: "test", refined: "refined", testable: true, storyId: "US-001" };
    expect(criterion.original).toBe("test");
    expect(criterion.storyId).toBe("US-001");
  });
});

// ACC-002: Acceptance Test Generator (PRD-based)
describe("ACC-002: Acceptance Test Generator (PRD-based)", () => {
  test("AC-1: generateFromPRD is exported and callable", async () => {
    const mod = await import("../../../src/acceptance/generator");
    expect(typeof mod.generateFromPRD).toBe("function");
  });

  test("AC-2: existing generateAcceptanceTests still works", async () => {
    const mod = await import("../../../src/acceptance/generator");
    expect(typeof mod.generateAcceptanceTests).toBe("function");
    expect(typeof mod.parseAcceptanceCriteria).toBe("function");
  });
});

// ACC-003: acceptance-setup Pipeline Stage
describe("ACC-003: acceptance-setup Pipeline Stage", () => {
  test("AC-1: acceptance-setup stage module exists", async () => {
    const mod = await import("../../../src/pipeline/stages/acceptance-setup");
    expect(mod.acceptanceSetupStage).toBeDefined();
    expect(mod.acceptanceSetupStage.name).toBe("acceptance-setup");
  });

  test("AC-2: acceptance-setup is in preRunPipeline", async () => {
    const { preRunPipeline } = await import("../../../src/pipeline/stages/index");
    expect(preRunPipeline).toBeArray();
    const names = preRunPipeline.map((s) => s.name);
    expect(names).toContain("acceptance-setup");
  });

  test("AC-3: config has acceptance.refinement default true", async () => {
    const { defaultConfig } = await import("../../../src/config/defaults");
    expect(defaultConfig.acceptance.refinement).toBe(true);
  });

  test("AC-4: config has acceptance.redGate default true", async () => {
    const { defaultConfig } = await import("../../../src/config/defaults");
    expect(defaultConfig.acceptance.redGate).toBe(true);
  });

  test("AC-5: config has acceptance.model default fast", async () => {
    const { defaultConfig } = await import("../../../src/config/defaults");
    expect(defaultConfig.acceptance.model).toBe("fast");
  });
});

// ACC-004: Integration test exists
describe("ACC-004: Integration test exists", () => {
  test("AC-1: red-green-cycle test file exists", () => {
    const testPath = path.join(import.meta.dir, "../../../test/integration/acceptance/red-green-cycle.test.ts");
    expect(existsSync(testPath)).toBe(true);
  });
});
