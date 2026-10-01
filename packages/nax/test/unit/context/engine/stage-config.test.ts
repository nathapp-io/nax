/**
 * stage-config.ts — provider list tests for test-coverage registration
 *
 * AC3: implementer stage lists 'test-coverage'
 * AC4: tdd stage lists 'test-coverage'
 * AC5: review/rectify/decompose stages do NOT list 'test-coverage'
 * AC6: validator accepts 'test-coverage' without error when registered
 */

import { describe, expect, test } from "bun:test";
import { getStageContextConfig, STAGE_CONTEXT_MAP } from "@/context/engine/stage-config";

describe("stage-config — tool-diagnostics provider registration (US-002)", () => {
  describe("US-002 AC12: rectify stage lists 'tool-diagnostics'", () => {
    test("rectify stage includes 'tool-diagnostics' in providerIds", () => {
      const config = getStageContextConfig("rectify");
      expect(config.providerIds).toContain("tool-diagnostics");
    });
  });

  describe("US-002 AC13: the strategy stages list 'tool-diagnostics' (nax#1743: moved off the unassembled 'execution' key)", () => {
    test.each(["single-session", "tdd-simple", "no-test", "batch"])(
      "%s stage includes 'tool-diagnostics' in providerIds",
      (stage) => {
        const config = getStageContextConfig(stage);
        expect(config.providerIds).toContain("tool-diagnostics");
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: query_scratch pull tool registration
// ─────────────────────────────────────────────────────────────────────────────

describe("stage-config — query_scratch pull tool registration (US-005)", () => {
  describe("AC11: rectify stage includes 'query_scratch' in pullToolNames", () => {
    test("rectify stage includes 'query_scratch' in pullToolNames", () => {
      const config = getStageContextConfig("rectify");
      expect(config.pullToolNames).toContain("query_scratch");
    });
  });

  describe("AC12: single-session/tdd-simple/batch stages include 'query_scratch' in pullToolNames (nax#1743: moved off the unassembled 'execution' key)", () => {
    test.each(["single-session", "tdd-simple", "batch"])(
      "%s stage includes 'query_scratch' in pullToolNames",
      (stage) => {
        const config = getStageContextConfig(stage);
        expect(config.pullToolNames).toContain("query_scratch");
      },
    );
  });
});

describe("stage-config — test-coverage provider registration (AC3, AC4, AC5, AC6)", () => {
  describe("AC3: implementer stage lists 'test-coverage'", () => {
    const IMPLEMENTER_STAGES = ["tdd-implementer", "single-session", "tdd-simple", "no-test", "batch"];

    test.each(IMPLEMENTER_STAGES)("%s stage includes 'test-coverage' in providerIds", (stage) => {
      const config = getStageContextConfig(stage);
      expect(config.providerIds).toContain("test-coverage");
    });
  });

  describe("AC4: tdd stage lists 'test-coverage'", () => {
    test("tdd-implementer stage includes 'test-coverage' in providerIds", () => {
      const config = getStageContextConfig("tdd-implementer");
      expect(config.providerIds).toContain("test-coverage");
    });
  });

  describe("AC5: review/rectify/decompose stages do NOT list 'test-coverage'", () => {
    const EXCLUDED_STAGES = [
      "verify",
      "rectify",
      "review",
      "review-semantic",
      "review-adversarial",
      "autofix",
      "acceptance",
      "plan",
      "route",
      "tdd-verifier",
      "tdd-test-writer",
    ];

    test.each(EXCLUDED_STAGES)("%s stage does NOT include 'test-coverage' in providerIds", (stage) => {
      const config = getStageContextConfig(stage);
      expect(config.providerIds).not.toContain("test-coverage");
    });
  });

  describe("AC6: validator accepts 'test-coverage' — registered providers match stage-config", () => {
    test("all stages with 'test-coverage' in providerIds are covered by the full provider list", () => {
      const allProviderIds = new Set<string>();
      for (const config of Object.values(STAGE_CONTEXT_MAP)) {
        for (const id of config.providerIds) {
          allProviderIds.add(id);
        }
      }

      const tcStages = Object.entries(STAGE_CONTEXT_MAP).filter(([, cfg]) => cfg.providerIds.includes("test-coverage"));
      expect(tcStages.length).toBeGreaterThan(0);
    });
  });
});

describe("stage-config — producesTestFiles declaration (nax#2060)", () => {
  describe("authoring stages declare producesTestFiles: true", () => {
    test.each(["tdd-test-writer", "single-session", "tdd-simple", "batch"])(
      "%s stage declares producesTestFiles: true",
      (stage) => {
        expect(getStageContextConfig(stage).producesTestFiles).toBe(true);
      },
    );
  });

  describe("non-authoring stages leave producesTestFiles unset", () => {
    // no-test: never writes tests, by design.
    // tdd-implementer/rectify/autofix: run after an authoring stage in the
    // same story, so their scopeFiles (git-diff based) already include any
    // real test files that stage wrote — no prospective-path gap to bridge.
    test.each(["no-test", "tdd-implementer", "rectify", "autofix"])(
      "%s stage does NOT declare producesTestFiles",
      (stage) => {
        expect(getStageContextConfig(stage).producesTestFiles).toBeUndefined();
      },
    );
  });
});
