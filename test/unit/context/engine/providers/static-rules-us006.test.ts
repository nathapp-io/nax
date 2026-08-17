/**
 * StaticRulesProvider — US-006 stage scoping
 *
 * US-006: stage scoping drives chunk emission from the real .nax/rules
 * store. The test-authoring rules declare `stages:` lists excluding
 * plan/acceptance/route so they never appear in plan or acceptance or
 * route contexts.
 *
 * US-006 AC 4 originally asserted the opposite for forbidden-patterns-*
 * and project-conventions: those declared no `stages:` key, so they loaded
 * everywhere including plan. #1612 gave all three an explicit stage list
 * precisely to stop that — 6749 tokens of freight per plan prompt — so the
 * AC-4 cases below now assert exclusion at plan, paired with a positive
 * case at execution so a rule scoped to nothing cannot pass vacuously.
 *
 * These tests run against the real `.nax/rules/` directory by importing
 * the real `loadCanonicalRules` and re-wiring `_staticRulesDeps` to
 * invoke it for each test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import { loadCanonicalRules } from "../../../../../src/context/rules/canonical-loader";

describe("StaticRulesProvider — US-006 real .nax/rules store stage scoping", () => {
  const REAL_REPO_REQUEST: ContextRequest = {
    storyId: "US-006",
    repoRoot: process.cwd(),
    packageDir: process.cwd(),
    stage: "execution",
    role: "implementer",
    budgetTokens: 8000,
  };

  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => loadCanonicalRules(workdir);
  });

  afterEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("[US-006 AC 3] emits no static-rules:test-writing: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:test-architecture: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-architecture:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:test-helpers: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:testing-commands: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:testing-commands:"))).toBe(false);
  });

  // Split into -source/-tests by SPEC-bounded-rules-floor US-005; the stage
  // scoping introduced by #1612 applies to both halves.
  const STAGE_SCOPED_EVERYWHERE_BUT_PLAN = [
    "forbidden-patterns-source",
    "forbidden-patterns-tests",
    "project-conventions",
  ] as const;

  for (const rule of STAGE_SCOPED_EVERYWHERE_BUT_PLAN) {
    test(`[US-006 AC 4] emits no static-rules:${rule}: chunk when request.stage is plan`, async () => {
      const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
      const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
      expect(result.chunks.some((c) => c.id.startsWith(`static-rules:${rule}:`))).toBe(false);
    });

    // Guards the exclusion above against passing vacuously: a rule scoped to
    // no stage at all, or one that stopped loading entirely, would satisfy the
    // plan-stage assertion while silently reaching no agent anywhere.
    test(`[US-006 AC 4] emits a static-rules:${rule}: chunk when request.stage is execution`, async () => {
      const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
      const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "execution" });
      expect(result.chunks.some((c) => c.id.startsWith(`static-rules:${rule}:`))).toBe(true);
    });
  }

  test("[US-006 AC 5] emits a static-rules:test-writing: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(true);
  });

  test("[US-006 AC 5] emits a static-rules:test-architecture: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-architecture:"))).toBe(true);
  });

  test("[US-006 AC 5] emits a static-rules:test-helpers: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(true);
  });
});
