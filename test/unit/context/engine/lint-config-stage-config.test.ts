/**
 * stage-config.ts — US-004 LintConfigProvider provider-list tests
 *
 * AC15: rectify stage context config is resolved → providerIds includes 'lint-config'.
 * AC16: execution stage context config is resolved → providerIds does not include 'lint-config'.
 */

import { describe, expect, test } from "bun:test";
import { STAGE_CONTEXT_MAP, getStageContextConfig } from "@/context/engine";

describe("stage-config — lint-config provider registration (US-004 AC15, AC16)", () => {
  test("AC15: rectify stage includes 'lint-config' in providerIds", () => {
    const config = getStageContextConfig("rectify");
    expect(config.providerIds).toContain("lint-config");
  });

  test("AC16: execution stage does NOT include 'lint-config' in providerIds", () => {
    const config = getStageContextConfig("execution");
    expect(config.providerIds).not.toContain("lint-config");
  });

  test("US-004: stages with lint-config in providerIds are limited to rectify (per spec scope)", () => {
    const stagesWithLintConfig = Object.entries(STAGE_CONTEXT_MAP)
      .filter(([, cfg]) => cfg.providerIds.includes("lint-config"))
      .map(([stage]) => stage);

    // Per the spec scope, only the rectify stage activates this provider.
    expect(stagesWithLintConfig).toContain("rectify");
    expect(stagesWithLintConfig).not.toContain("execution");
    expect(stagesWithLintConfig).not.toContain("context");
    expect(stagesWithLintConfig).not.toContain("plan");
    expect(stagesWithLintConfig).not.toContain("tdd-implementer");
    expect(stagesWithLintConfig).not.toContain("single-session");
    expect(stagesWithLintConfig).not.toContain("tdd-simple");
    expect(stagesWithLintConfig).not.toContain("no-test");
    expect(stagesWithLintConfig).not.toContain("batch");
  });

  test("US-004: stage-config maps lint-config to a registered provider id", () => {
    const providerIds = new Set<string>();
    for (const cfg of Object.values(STAGE_CONTEXT_MAP)) {
      for (const id of cfg.providerIds) providerIds.add(id);
    }
    expect(providerIds.has("lint-config")).toBe(true);
  });
});
