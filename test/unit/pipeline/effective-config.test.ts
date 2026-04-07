/**
 * Unit tests for per-package effective config resolution (PKG-003, PKG-005)
 *
 * Tests that:
 * - ctx.config carries the effective (merged) config for the story's package
 * - ctx.rootConfig carries the unmerged root config
 * - Stages use ctx.config for package-relevant fields
 */

import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";
import type { ReviewResult } from "../../../src/review/types";

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
  test("verify stage uses ctx.config (effective config) when set", async () => {
    const { verifyStage, _verifyDeps } = await import("../../../src/pipeline/stages/verify");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      quality: {
        ...DEFAULT_CONFIG.quality,
        requireTests: false, // package disables tests
        commands: {},
      },
    };

    const ctx = makeCtx({ config: packageConfig });

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

  test("verify stage uses ctx.config.quality.requireTests", async () => {
    const { verifyStage, _verifyDeps } = await import("../../../src/pipeline/stages/verify");

    const config = makeBaseConfig({
      quality: {
        ...DEFAULT_CONFIG.quality,
        requireTests: false,
        commands: {},
      },
    });

    const ctx = makeCtx({ config });

    const origRegression = _verifyDeps.regression;
    let regressionCalled = false;
    _verifyDeps.regression = mock((): Promise<import("../../../src/verification").VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve({ status: "SUCCESS", success: true, countsTowardEscalation: true });
    });

    try {
      const result = await verifyStage.execute(ctx);
      // ctx.config.requireTests=false → continue
      expect(result.action).toBe("continue");
      expect(regressionCalled).toBe(false);
    } finally {
      _verifyDeps.regression = origRegression;
    }
  });

  test("review stage uses ctx.config.review.enabled to gate execution", () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      review: { enabled: false, checks: [], commands: {}, pluginMode: "per-story" },
    };

    const ctx = makeCtx({ config: packageConfig });
    // enabled() should return false since ctx.config.review.enabled = false
    expect(reviewStage.enabled(ctx)).toBe(false);
  });

  test("review stage enabled=true when ctx.config.review.enabled=true", () => {
    const { reviewStage } = require("../../../src/pipeline/stages/review");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      review: { enabled: true, checks: [], commands: {}, pluginMode: "per-story" },
    };

    const ctx = makeCtx({ config: packageConfig });
    expect(reviewStage.enabled(ctx)).toBe(true);
  });

  test("regression stage uses ctx.config.execution.regressionGate.mode", () => {
    const { regressionStage } = require("../../../src/pipeline/stages/regression");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode: "per-story", timeoutSeconds: 120, acceptOnTimeout: true },
      },
    };

    const ctx = makeCtx({ config: packageConfig });
    expect(regressionStage.enabled(ctx)).toBe(true);
  });

  test("regression stage disabled when ctx.config.execution.regressionGate.mode=deferred", () => {
    const { regressionStage } = require("../../../src/pipeline/stages/regression");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 120, acceptOnTimeout: true },
      },
    };

    const ctx = makeCtx({ config: packageConfig });
    expect(regressionStage.enabled(ctx)).toBe(false);
  });

  test("acceptance stage uses ctx.config.acceptance.enabled", () => {
    const { acceptanceStage } = require("../../../src/pipeline/stages/acceptance");

    const packageConfig: NaxConfig = {
      ...makeBaseConfig(),
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
    };

    // Mark all stories complete so the only gate is acceptance.enabled
    const story = makeStory({ status: "passed" });
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

// ---------------------------------------------------------------------------
// autofix stage reads lintFix/formatFix from review.commands as fallback
// ---------------------------------------------------------------------------

describe("autofix stage lintFix source", () => {
  test("uses quality.commands.lintFix when defined", async () => {
    const { autofixStage, _autofixDeps } = await import("../../../src/pipeline/stages/autofix");

    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async (opts) => {
      commandsRun.push(opts.commandName);
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 0,
        timedOut: false,
      };
    };
    _autofixDeps.recheckReview = async () => true;

    const config = makeBaseConfig({
      quality: { ...DEFAULT_CONFIG.quality, commands: { lintFix: "bun run lint:fix" }, autofix: { enabled: true } },
      review: { ...DEFAULT_CONFIG.review, commands: {} },
    });
    const ctx = makeCtx({
      config,
      reviewResult: {
        success: false,
        checks: [
          { check: "lint", success: false, command: "bun run lint", exitCode: 1, output: "lint error", durationMs: 0 },
        ],
        totalDurationMs: 0,
      } satisfies ReviewResult,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(commandsRun).toContain("lintFix");
  });

  test("falls back to review.commands.lintFix when quality.commands.lintFix is absent", async () => {
    const { autofixStage, _autofixDeps } = await import("../../../src/pipeline/stages/autofix");

    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async (opts) => {
      commandsRun.push(opts.commandName);
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 0,
        timedOut: false,
      };
    };
    _autofixDeps.recheckReview = async () => true;

    const config = makeBaseConfig({
      quality: { ...DEFAULT_CONFIG.quality, commands: {}, autofix: { enabled: true } },
      review: { ...DEFAULT_CONFIG.review, commands: { lintFix: "bun run lint:fix" } },
    });
    const ctx = makeCtx({
      config,
      reviewResult: {
        success: false,
        checks: [
          { check: "lint", success: false, command: "bun run lint", exitCode: 1, output: "lint error", durationMs: 0 },
        ],
      } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(commandsRun).toContain("lintFix");
  });

  test("skips mechanical fix when neither quality.commands nor review.commands defines lintFix", async () => {
    const { autofixStage, _autofixDeps } = await import("../../../src/pipeline/stages/autofix");

    const saved = { ..._autofixDeps };
    let qualityCommandCalled = false;
    _autofixDeps.runQualityCommand = async (opts) => {
      qualityCommandCalled = true;
      return {
        commandName: opts.commandName,
        command: opts.command,
        success: true,
        exitCode: 0,
        output: "",
        durationMs: 0,
        timedOut: false,
      };
    };
    _autofixDeps.runAgentRectification = async () => false;

    const config = makeBaseConfig({
      quality: { ...DEFAULT_CONFIG.quality, commands: {}, autofix: { enabled: true } },
      review: { ...DEFAULT_CONFIG.review, commands: {} },
    });
    const ctx = makeCtx({
      config,
      reviewResult: {
        success: false,
        checks: [
          { check: "lint", success: false, command: "bun run lint", exitCode: 1, output: "lint error", durationMs: 0 },
        ],
      } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(qualityCommandCalled).toBe(false);
  });
});
