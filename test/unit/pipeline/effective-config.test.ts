/**
 * Unit tests for per-package effective config resolution (PKG-003, PKG-005)
 *
 * Tests that:
 * - effectiveConfig falls back to ctx.config when effectiveConfig is absent (legacy contexts)
 * - effectiveConfig is passed correctly when set
 * - Stages use effectiveConfig for package-relevant fields
 */

import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "A test story",
    acceptanceCriteria: [],
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function makePrd(story?: UserStory): PRD {
  const s = story ?? makeStory();
  return {
    feature: "test-feature",
    version: "1",
    userStories: [s],
  };
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
    effectiveConfig: config,
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
  test("no package override → effectiveConfig equals root", () => {
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
// Stage fallback behavior — effectiveConfig ?? ctx.config
// ---------------------------------------------------------------------------

describe("stage effectiveConfig fallback", () => {
  test("verify stage uses ctx.effectiveConfig when set", async () => {
    const { verifyStage, _verifyDeps } = await import("../../../src/pipeline/stages/verify");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      quality: {
        ...DEFAULT_CONFIG.quality,
        requireTests: false, // package disables tests
        commands: {},
      },
    };

    const ctx = makeCtx({ effectiveConfig: packageConfig });

    const origRegression = _verifyDeps.regression;
    let regressionCalled = false;
    _verifyDeps.regression = mock((): Promise<import("../../../src/verification").VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve({ status: "SUCCESS", success: true, countsTowardEscalation: true });
    });

    try {
      const result = await verifyStage.execute(ctx);
      // requireTests=false → skip verification → continue
      expect(result.action).toBe("continue");
      expect(regressionCalled).toBe(false);
    } finally {
      _verifyDeps.regression = origRegression;
    }
  });

  test("verify stage falls back to ctx.config when effectiveConfig is absent", async () => {
    const { verifyStage, _verifyDeps } = await import("../../../src/pipeline/stages/verify");

    const config = makeBaseConfig({
      quality: {
        ...DEFAULT_CONFIG.quality,
        requireTests: false,
        commands: {},
      },
    });

    // Construct ctx without effectiveConfig (legacy context)
    const ctx = {
      config,
      // effectiveConfig intentionally absent
      prd: makePrd(),
      story: makeStory(),
      stories: [makeStory()],
      routing: { complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "" },
      workdir: "/tmp/test",
      hooks: { hooks: {} },
    } as Parameters<typeof verifyStage.execute>[0];

    const origRegression = _verifyDeps.regression;
    let regressionCalled = false;
    _verifyDeps.regression = mock((): Promise<import("../../../src/verification").VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve({ status: "SUCCESS", success: true, countsTowardEscalation: true });
    });

    try {
      const result = await verifyStage.execute(ctx);
      // Falls back to ctx.config → requireTests=false → continue
      expect(result.action).toBe("continue");
      expect(regressionCalled).toBe(false);
    } finally {
      _verifyDeps.regression = origRegression;
    }
  });

  test("review stage uses ctx.effectiveConfig.review.enabled to gate execution", () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      review: { enabled: false, checks: [], commands: {}, pluginMode: "per-story" },
    };

    const ctx = makeCtx({ effectiveConfig: packageConfig });
    // enabled() should return false since effectiveConfig.review.enabled = false
    expect(reviewStage.enabled(ctx)).toBe(false);
  });

  test("review stage enabled=true when effectiveConfig.review.enabled=true", () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      review: { enabled: true, checks: [], commands: {}, pluginMode: "per-story" },
    };

    const ctx = makeCtx({ effectiveConfig: packageConfig });
    expect(reviewStage.enabled(ctx)).toBe(true);
  });

  test("regression stage uses effectiveConfig.execution.regressionGate.mode", () => {
    const { regressionStage } = require("../../../src/pipeline/stages/regression");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode: "per-story", timeoutSeconds: 120, acceptOnTimeout: true },
      },
    };

    const ctx = makeCtx({ effectiveConfig: packageConfig });
    expect(regressionStage.enabled(ctx)).toBe(true);
  });

  test("regression stage disabled when effectiveConfig.execution.regressionGate.mode=deferred", () => {
    const { regressionStage } = require("../../../src/pipeline/stages/regression");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 120, acceptOnTimeout: true },
      },
    };

    const ctx = makeCtx({ effectiveConfig: packageConfig });
    expect(regressionStage.enabled(ctx)).toBe(false);
  });

  test("acceptance stage uses effectiveConfig.acceptance.enabled", () => {
    const { acceptanceStage } = require("../../../src/pipeline/stages/acceptance");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
    };

    // Mark all stories complete so the only gate is acceptance.enabled
    const story = makeStory({ status: "passed" });
    const prd = makePrd(story);
    const ctx = makeCtx({
      effectiveConfig: packageConfig,
      story,
      prd,
    });

    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectiveConfig is the correct merged config for a monorepo story
// ---------------------------------------------------------------------------

describe("effectiveConfig per-story isolation", () => {
  test("two stories with different package configs get different effectiveConfigs", () => {
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

  test("story without workdir gets root config as effectiveConfig", () => {
    const root = makeBaseConfig();
    // No workdir means effectiveConfig === root
    const result = mergePackageConfig(root, {});
    expect(result).toBe(root);
  });
});
