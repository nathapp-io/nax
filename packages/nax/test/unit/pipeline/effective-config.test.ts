/**
 * Unit tests for per-package effective config resolution (PKG-003, PKG-005)
 *
 * Tests that:
 * - ctx.config carries the effective (merged) config for the story's package
 * - ctx.rootConfig carries the unmerged root config
 * - Stages use ctx.config for package-relevant fields
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { mergePackageConfig } from "@/config/merge";
import type { NaxConfig } from "@/config/schema";

function makeBaseConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: { test: "bun test" },
    },
    ...overrides,
  } as NaxConfig;
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
      review: { ...DEFAULT_CONFIG.review, enabled: true, checks: ["lint"], commands: {}, pluginMode: "gating" },
    };
    const result = mergePackageConfig(root, {
      review: { enabled: false } as Partial<NaxConfig["review"]>,
    } as Partial<NaxConfig>);

    expect(result.review.enabled).toBe(false);
    expect(root.review.enabled).toBe(true); // root unchanged
  });

  test("package override with execution.smartTestRunner=false → merged config has smart-runner disabled", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {
      execution: { smartTestRunner: false } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>);

    expect(result.execution.smartTestRunner).toBe(false);
  });

  test("package override with quality.commands.test → command changed", () => {
    const root = makeBaseConfig();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "go test ./..." } } as Partial<NaxConfig["quality"]>,
    } as Partial<NaxConfig>);

    expect(result.quality.commands.test).toBe("go test ./...");
    expect(root.quality.commands.test).toBe("bun test"); // root unchanged
  });
});

// ---------------------------------------------------------------------------
// Stage behavior — ctx.config carries the effective (merged) config
//
// The last test here ("acceptance stage uses ctx.config.acceptance.enabled") was
// deleted with pipeline-post-run-delete US-005: the acceptance stage no longer
// exists.
// ---------------------------------------------------------------------------

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
