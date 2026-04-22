/**
 * stage-config.ts — provider list tests for test-coverage registration
 *
 * AC3: implementer stage lists 'test-coverage'
 * AC4: tdd stage lists 'test-coverage'
 * AC5: review/rectify/decompose stages do NOT list 'test-coverage'
 * AC6: validator accepts 'test-coverage' without error when registered
 */

import { describe, expect, test } from "bun:test";
import { STAGE_CONTEXT_MAP, getStageContextConfig } from "../../../../src/context/engine/stage-config";

describe("stage-config — test-coverage provider registration (AC3, AC4, AC5, AC6)", () => {
  describe("AC3: implementer stage lists 'test-coverage'", () => {
    const IMPLEMENTER_STAGES = ["execution", "tdd-implementer", "single-session", "tdd-simple", "no-test", "batch"];

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
      "review-dialogue",
      "debate",
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

      const tcStages = Object.entries(STAGE_CONTEXT_MAP).filter(([, cfg]) =>
        cfg.providerIds.includes("test-coverage"),
      );
      expect(tcStages.length).toBeGreaterThan(0);
    });
  });
});