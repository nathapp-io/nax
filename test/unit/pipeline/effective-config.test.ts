/**
 * Unit tests for per-package effective config resolution (PKG-003, PKG-005)
 *
 * Tests that:
 * - ctx.config carries the effective (merged) config for the story's package
 * - ctx.rootConfig carries the unmerged root config
 * - Stages use ctx.config for package-relevant fields
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";
import { makeStory } from "../../helpers";

function makePrd(story?: UserStory): PRD {
  const s = story ?? makeStory();
  return {
    feature: "test-feature",
    userStories: [s],
  } as PRD;
}

function makeBaseConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      requireTests: true,
      commands: { test: "bun test" },
    },
    ...overrides,
  } as NaxConfig;
}

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const story = makeStory();
  const config = makeBaseConfig();
  return {
    config,
    rootConfig: config,
    prd: makePrd(story),
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
    workdir: "/tmp/test-project",
    hooks: { hooks: {} },
    ...overrides,
  } as PipelineContext;
}

// ---------------------------------------------------------------------------
// mergePackageConfig integration — verify merged result is correct
// ---------------------------------------------------------------------------

describe("mergePackageConfig integration", () => {
  test("no package override → merged config equals root", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {});
    expect(result).toBe(root);
  });

  test("package override with quality.commands → merged config differs from root", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "jest" } },
    } as Partial<NaxConfig>);

    expect(result).not.toBe(root);
    expect(result.quality.commands.test).toBe("jest");
    expect(root.quality.commands.test).toBe("bun test"); // root unchanged
  });

  test("package override with review.enabled=false → merged config has review disabled", () => {
    const root: NaxConfig = {
      ...makeBaseConfig(),
      review: { enabled: true, checks: ["lint"], commands: {}, pluginMode: "per-story" },
    };
    const result = mergePackageConfig(root, {
      review: { enabled: false } as Partial<NaxConfig["review"]>,
    } as Partial<NaxConfig>);

    expect(result.review.enabled).toBe(false);
    expect(root.review.enabled).toBe(true); // root unchanged
  });

  test("package override with acceptance.enabled=false → merged config has acceptance disabled", () => {
    const root: NaxConfig = {
      ...makeBaseConfig(),
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true },
    };
    const result = mergePackageConfig(root, {
      acceptance: { enabled: false } as Partial<NaxConfig["acceptance"]>,
    } as Partial<NaxConfig>);

    expect(result.acceptance.enabled).toBe(false);
    expect(root.acceptance.enabled).toBe(true); // root unchanged
  });

  test("package override with execution.smartTestRunner=false → merged config has smart-runner disabled", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {
      execution: { smartTestRunner: false } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>);

    expect(result.execution.smartTestRunner).toBe(false);
  });

  test("package override with regressionGate.mode=per-story → mode changed", () => {
    const root: NaxConfig = {
      ...makeBaseConfig(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 120, acceptOnTimeout: true },
      },
    };
    const result = mergePackageConfig(root, {
      execution: {
        regressionGate: { mode: "per-story" },
      } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>);

    expect(result.execution.regressionGate.mode).toBe("per-story");
    expect(result.execution.regressionGate.enabled).toBe(true); // preserved
  });

  test("package override with quality.requireTests=false → requireTests changed", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {
      quality: { requireTests: false } as Partial<NaxConfig["quality"]>,
    } as Partial<NaxConfig>);

    expect(result.quality.requireTests).toBe(false);
    expect(root.quality.requireTests).toBe(true); // root unchanged
  });
});

// ---------------------------------------------------------------------------
// Stage behavior — ctx.config carries the effective (merged) config
// ---------------------------------------------------------------------------

describe("stage config usage", () => {
  // Note: regressionStage tests removed (issue #1116) — stage deleted; regression gate behavior
  // is now tested in test/unit/operations/full-suite-gate.test.ts and
  // test/unit/operations/verify-scoped.test.ts.

  test("acceptance stage uses ctx.config.acceptance.enabled", () => {
    const { acceptanceStage } = require("../../../src/pipeline/stages/acceptance");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
    };

    // Mark all stories complete so the only gate is acceptance.enabled
    const story = makeStory({ status: "passed", passes: true, attempts: 1 });
    const prd = makePrd(story);
    const ctx = makeCtx({
      config: packageConfig,
      story,
      prd,
    });

    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ctx.config is the correct merged config for a monorepo story
// ---------------------------------------------------------------------------

describe("per-story config isolation", () => {
  test("two stories with different package configs get different merged configs", () => {
    const rootConfig = makeBaseConfig();

    const pkgApiOverride: Partial<NaxConfig> = {
      quality: { commands: { test: "jest --testPathPattern={{files}}" } },
    } as Partial<NaxConfig>;

    const pkgWebOverride: Partial<NaxConfig> = {
      quality: { commands: { test: "vitest run" } },
      execution: { smartTestRunner: false } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>;

    const effectiveApi = mergePackageConfig(rootConfig, pkgApiOverride);
    const effectiveWeb = mergePackageConfig(rootConfig, pkgWebOverride);

    expect(effectiveApi.quality.commands.test).toBe("jest --testPathPattern={{files}}");
    expect(effectiveWeb.quality.commands.test).toBe("vitest run");
    expect(effectiveWeb.execution.smartTestRunner).toBe(false);

    // Root unchanged
    expect(rootConfig.quality.commands.test).toBe("bun test");
  });

  test("story without workdir gets root config as effective config", () => {
    const root = makeBaseConfig();
    // No workdir means ctx.config === rootConfig
    const result = mergePackageConfig(root, {});
    expect(result).toBe(root);
  });
});
