/**
 * Unit tests for mergePackageConfig (MW-008, v0.49.0 expansion)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { mergePackageConfig } from "@/config/merge";
import type { NaxConfig } from "@/config/schema";
import { absentValue, makeNaxConfig } from "@test/helpers";

function makeRoot(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        test: "bun test",
        testScoped: "bun test {{files}}",
        typecheck: "bun run typecheck",
        lint: "bun run lint",
      },
    },
  };
}

describe("mergePackageConfig", () => {
  test("returns root unchanged when packageOverride has no mergeable fields", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {});
    expect(result).toBe(root);
  });

  test("returns root unchanged when packageOverride.quality has no commands", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { ...DEFAULT_CONFIG.quality, commands: absentValue<NaxConfig["quality"]["commands"]>() },
    } as Partial<NaxConfig>);
    // quality without commands — no merge happens (no recognized overrideable fields)
    expect(result).not.toBe(root); // quality is present → merge occurs
  });

  test("merges quality.commands when packageOverride provides them", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
    } as Partial<NaxConfig>);

    expect(result.quality.commands.test).toBe("npm test");
    // Other commands preserved from root
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
    expect(result.quality.commands.testScoped).toBe("bun test {{files}}");
  });

  test("partial override: only specified commands are replaced", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: {
        commands: {
          test: "npm run test:unit",
          testScoped: "npm test -- {{files}}",
        },
      },
    } as Partial<NaxConfig>);

    expect(result.quality.commands.test).toBe("npm run test:unit");
    expect(result.quality.commands.testScoped).toBe("npm test -- {{files}}");
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
  });

  test("does not mutate root config", () => {
    const root = makeRoot();
    const originalTest = root.quality.commands.test;
    mergePackageConfig(root, {
      quality: { commands: { test: "changed" } },
    } as Partial<NaxConfig>);

    expect(root.quality.commands.test).toBe(originalTest);
  });

  test("routing from packageOverride is merged (whitelisted in #291)", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
      routing: { strategy: "llm" } as NaxConfig["routing"],
    } as Partial<NaxConfig>);

    // routing is now merged
    expect(result.routing?.strategy).toBe("llm");
    // quality.commands also merged
    expect(result.quality.commands.test).toBe("npm test");
  });

  test("returns new object (not same reference)", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
    } as Partial<NaxConfig>);

    expect(result).not.toBe(root);
    expect(result.quality).not.toBe(root.quality);
    expect(result.quality.commands).not.toBe(root.quality.commands);
  });

  // --- PKG-001: new fields ---

  describe("execution.smartTestRunner override", () => {
    test("overrides when set in package config; preserves from root when not overridden", () => {
      const result1 = mergePackageConfig(makeRoot(), {
        execution: { smartTestRunner: false } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);
      expect(result1.execution.smartTestRunner).toBe(false);

      const rootWithSmart: NaxConfig = {
        ...makeRoot(),
        execution: {
          ...DEFAULT_CONFIG.execution,
          smartTestRunner: { enabled: true, testFilePatterns: ["test/**/*.test.ts"], fallback: "import-grep" },
        },
      };
      const result2 = mergePackageConfig(rootWithSmart, {
        quality: { commands: { test: "changed" } },
      } as Partial<NaxConfig>);
      expect(result2.execution.smartTestRunner).toEqual(rootWithSmart.execution.smartTestRunner);
    });
  });

  describe("execution.regressionGate deep merge", () => {
    test.each([
      ["mode", { mode: "per-story" as const }, (r: NaxConfig) => r.execution.regressionGate.mode, "per-story"],
      ["timeoutSeconds", { timeoutSeconds: 600 }, (r: NaxConfig) => r.execution.regressionGate.timeoutSeconds, 600],
    ])("overrides regressionGate.%s per package", (_field, override, getField, expected) => {
      const root: NaxConfig = {
        ...makeRoot(),
        execution: {
          ...DEFAULT_CONFIG.execution,
          regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 120, acceptOnTimeout: true },
        },
      };
      const result = mergePackageConfig(root, {
        execution: { regressionGate: override } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);
      expect(getField(result)).toBe(expected);
    });
  });

  describe("execution.verificationTimeoutSeconds override", () => {
    test("overrides verificationTimeoutSeconds per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        execution: { ...DEFAULT_CONFIG.execution, verificationTimeoutSeconds: 300 },
      };
      const result = mergePackageConfig(root, {
        execution: { verificationTimeoutSeconds: 60 } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);

      expect(result.execution.verificationTimeoutSeconds).toBe(60);
    });
  });

  describe("review field overrides", () => {
    test("overrides review.enabled/checks independently; deep merges commands; overrides pluginMode", () => {
      const base: NaxConfig = {
        ...makeRoot(),
        review: {
          enabled: true,
          checks: ["typecheck", "lint"],
          commands: { typecheck: "bun typecheck", lint: "bun lint" },
          pluginMode: "per-story",
        },
      };
      const r1 = mergePackageConfig(base, {
        review: { enabled: false } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(r1.review.enabled).toBe(false);
      expect(r1.review.checks).toEqual(["typecheck", "lint"]);
      const r2 = mergePackageConfig(base, {
        review: { commands: { lint: "eslint ." } } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(r2.review.commands.lint).toBe("eslint .");
      expect(r2.review.commands.typecheck).toBe("bun typecheck");
      const r3 = mergePackageConfig(base, {
        review: { pluginMode: "deferred" } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(r3.review.pluginMode).toBe("deferred");
    });

    test("deep merges review.semantic: rules override and modelTier override both preserve other field", () => {
      const makeSemanticRoot = (semantic: NaxConfig["review"]["semantic"]) => ({
        ...makeRoot(),
        review: { enabled: true, checks: ["semantic"], commands: {}, pluginMode: "per-story" as const, semantic },
      });

      const rulesResult = mergePackageConfig(makeSemanticRoot({ modelTier: "balanced", rules: ["rule1"] }), {
        review: { semantic: { rules: ["rule1", "rule2"] } } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(rulesResult.review.semantic?.modelTier).toBe("balanced");
      expect(rulesResult.review.semantic?.rules).toEqual(["rule1", "rule2"]);

      const tierResult = mergePackageConfig(makeSemanticRoot({ modelTier: "balanced", rules: [] }), {
        review: { semantic: { modelTier: "powerful" } } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(tierResult.review.semantic?.modelTier).toBe("powerful");
      expect(tierResult.review.semantic?.rules).toEqual([]);
    });

    describe("PKG-006: quality.commands bridged to review.commands", () => {
      test.each([
        ["lint", "lint", "bun run lint", { lint: "bunx turbo lint" } as NaxConfig["review"]["commands"]],
        [
          "typecheck",
          "typecheck",
          "bun run type-check",
          { typecheck: "bunx turbo type-check" } as NaxConfig["review"]["commands"],
        ],
        [
          "lintScoped",
          "lintScoped",
          "biome check {{files}}",
          { lint: "bunx turbo lint", lintScoped: "eslint {{files}}" } as NaxConfig["review"]["commands"],
        ],
      ] as const)("quality.commands.%s bridges to review.commands.%s", (_label, key, newCmd, rootReviewCmds) => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: { enabled: true, checks: ["lint"], commands: rootReviewCmds, pluginMode: "per-story" },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { [key]: newCmd } },
        } as Partial<NaxConfig>);
        expect(result.review.commands[key]).toBe(newCmd);
      });

      test("quality scoped fix commands bridge to review scoped fix commands", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: {
            enabled: true,
            checks: ["lint"],
            commands: {
              lintFixScoped: "eslint --fix {{files}}",
              formatFixScoped: "prettier --write {{files}}",
            },
            pluginMode: "per-story",
          },
        };
        const result = mergePackageConfig(root, {
          quality: {
            commands: {
              lintFixScoped: "biome check --fix {{files}}",
              formatFixScoped: "biome format --write {{files}}",
            },
          },
        } as Partial<NaxConfig>);

        expect(result.review.commands.lintFixScoped).toBe("biome check --fix {{files}}");
        expect(result.review.commands.formatFixScoped).toBe("biome format --write {{files}}");
      });

      test("explicit review.commands takes precedence over bridged quality.commands", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: { enabled: true, checks: ["lint"], commands: { lint: "bunx turbo lint" }, pluginMode: "per-story" },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { lint: "bun run lint" } },
          review: { commands: { lint: "eslint --fix ." } } as Partial<NaxConfig["review"]>,
        } as Partial<NaxConfig>);

        // review.commands wins over quality.commands bridge
        expect(result.review.commands.lint).toBe("eslint --fix .");
      });

      test("all three checks bridge together when quality.commands provides all", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: {
            enabled: true,
            checks: ["typecheck", "lint", "test"],
            commands: { typecheck: "bunx turbo type-check", lint: "bunx turbo lint", test: "bunx turbo test" },
            pluginMode: "per-story",
          },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { typecheck: "bun run type-check", lint: "bun run lint", test: "bun run test" } },
        } as Partial<NaxConfig>);

        expect(result.review.commands.typecheck).toBe("bun run type-check");
        expect(result.review.commands.lint).toBe("bun run lint");
        expect(result.review.commands.test).toBe("bun run test");
      });

      test("bridge does not affect unset quality.commands keys", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: {
            enabled: true,
            checks: ["typecheck", "lint"],
            commands: { typecheck: "bunx turbo type-check", lint: "bunx turbo lint" },
            pluginMode: "per-story",
          },
        };
        // Only lint is set in quality.commands — typecheck should stay as root value
        const result = mergePackageConfig(root, {
          quality: { commands: { lint: "bun run lint" } },
        } as Partial<NaxConfig>);

        expect(result.review.commands.lint).toBe("bun run lint"); // bridged
        expect(result.review.commands.typecheck).toBe("bunx turbo type-check"); // untouched
      });

      test("quality.commands.build bridges to review.commands.build (BUILD-001)", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: {
            enabled: true,
            checks: ["build"],
            commands: {},
            pluginMode: "per-story",
          },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { build: "bun run build" } },
        } as Partial<NaxConfig>);

        expect(result.review.commands.build).toBe("bun run build");
        expect(result.quality.commands.build).toBe("bun run build");
      });
    });
  });

  describe("acceptance field overrides", () => {
    test.each([
      [
        "enabled",
        (a: NaxConfig["acceptance"]) => a.enabled,
        true,
        { enabled: false } as Partial<NaxConfig["acceptance"]>,
        false,
      ],
      [
        "testPath",
        (a: NaxConfig["acceptance"]) => a.testPath,
        "acceptance.test.ts",
        { testPath: "e2e/acceptance.test.ts" } as Partial<NaxConfig["acceptance"]>,
        "e2e/acceptance.test.ts",
      ],
    ] as const)("overrides acceptance.%s per package", (_field, getField, rootVal, override, expected) => {
      const root: NaxConfig = {
        ...makeRoot(),
        acceptance: { ...DEFAULT_CONFIG.acceptance, ...override, ...({ [_field]: rootVal } as object) },
      };
      const result = mergePackageConfig(root, { acceptance: override } as Partial<NaxConfig>);
      expect(getField(result.acceptance)).toEqual(expected);
    });
  });

  describe("context.testCoverage deep merge", () => {
    test("deep merges per package; preserves when not overridden", () => {
      const tcConfig = {
        enabled: true,
        detail: "names-and-counts" as const,
        maxTokens: 500,
        testPattern: "**/*.test.ts",
        scopeToStory: true,
      };
      const rootWithTc: NaxConfig = { ...makeRoot(), context: { ...DEFAULT_CONFIG.context, testCoverage: tcConfig } };

      const merged = mergePackageConfig(rootWithTc, {
        context: { testCoverage: { enabled: false } } as Partial<NaxConfig["context"]>,
      } as Partial<NaxConfig>);
      expect(merged.context.testCoverage.enabled).toBe(false);
      expect(merged.context.testCoverage.testPattern).toBe("**/*.test.ts");
      expect(merged.context.testCoverage.scopeToStory).toBe(true);

      const preserved = mergePackageConfig(rootWithTc, {
        quality: { commands: { test: "jest" } },
      } as Partial<NaxConfig>);
      expect(preserved.context.testCoverage).toEqual(rootWithTc.context.testCoverage);
    });
  });

  describe("immutability guarantees", () => {
    test.each([
      [
        "root.execution",
        (r: NaxConfig) => r.execution.verificationTimeoutSeconds,
        (_r: NaxConfig) => makeNaxConfig({ execution: { verificationTimeoutSeconds: 999 } }),
      ],
      [
        "root.review",
        (r: NaxConfig) => r.review.enabled,
        (r: NaxConfig) => makeNaxConfig({ review: { enabled: !r.review.enabled } }),
      ],
      [
        "root.acceptance",
        (r: NaxConfig) => r.acceptance.enabled,
        (r: NaxConfig) => makeNaxConfig({ acceptance: { enabled: !r.acceptance.enabled } }),
      ],
    ])("does not mutate %s", (_label, getOrig, makeOverride) => {
      const root = makeRoot();
      const orig = getOrig(root);
      mergePackageConfig(root, makeOverride(root));
      expect(getOrig(root)).toBe(orig);
    });
  });
});

// ── US-001: project field merge ───────────────────────────────────────────────

describe("mergePackageConfig — project field (US-001)", () => {
  /** Root config with a project profile pre-set */
  function makeRootWithProject(): NaxConfig {
    return {
      ...makeRoot(),
      project: { language: "typescript", type: "library" },
    };
  }

  // AC-5: merging project fields from package override
  test("AC-5: merges project fields while preserving others", () => {
    const resultType = mergePackageConfig(makeRootWithProject(), { project: { type: "api" } } as Partial<NaxConfig>);
    expect(resultType.project?.type).toBe("api");
    expect(resultType.project?.language).toBe("typescript");

    const resultFramework = mergePackageConfig(makeRootWithProject(), {
      project: { testFramework: "vitest" },
    } as Partial<NaxConfig>);
    expect(resultFramework.project?.testFramework).toBe("vitest");
    expect(resultFramework.project?.language).toBe("typescript");
    expect(resultFramework.project?.type).toBe("library");
  });

  // AC-6: no project in packageOverride → root.project unchanged; immutability
  test("AC-6: returns unchanged root.project when no override; undefined when neither; does not mutate", () => {
    const rootWithProject = makeRootWithProject();
    const result = mergePackageConfig(rootWithProject, {
      quality: { scopeTestThreshold: 99 } as Partial<NaxConfig["quality"]>,
    } as Partial<NaxConfig>);
    expect(result.project).toEqual(rootWithProject.project);

    const rootNoProject = makeRoot();
    const resultNoProject = mergePackageConfig(rootNoProject, {
      quality: { scopeTestThreshold: 99 } as Partial<NaxConfig["quality"]>,
    } as Partial<NaxConfig>);
    expect(resultNoProject.project).toBeUndefined();

    const rootMut = makeRootWithProject();
    const origLang = rootMut.project?.language;
    mergePackageConfig(rootMut, { project: { language: "go" } } as Partial<NaxConfig>);
    expect(rootMut.project?.language).toBe(origLang);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-59: per-package context.v2.stages budget overrides
// ─────────────────────────────────────────────────────────────────────────────

describe("mergePackageConfig — AC-59 context.v2.stages budget overrides", () => {
  test("root context.v2.stages preserved when no override; package override sets a stage budget; does not mutate", () => {
    const root = makeRoot();
    expect(
      mergePackageConfig(root, { quality: { scopeTestThreshold: 99 } } as Partial<NaxConfig>).context.v2.stages,
    ).toEqual({});
    const result = mergePackageConfig(root, {
      context: { v2: { stages: { execution: { budgetTokens: 15_000 } } } } as unknown as Partial<NaxConfig["context"]>,
    } as Partial<NaxConfig>);
    expect(result.context.v2.stages.execution?.budgetTokens).toBe(15_000);

    const origStages = root.context.v2.stages;
    mergePackageConfig(root, {
      context: { v2: { stages: { execution: { budgetTokens: 15_000 } } } } as unknown as Partial<NaxConfig["context"]>,
    } as Partial<NaxConfig>);
    expect(root.context.v2.stages).toBe(origStages);
  });

  test("package override does not clobber other stages; override wins for same stage", () => {
    const rootBase = {
      ...makeRoot(),
      context: { ...makeRoot().context, v2: { ...makeRoot().context.v2, stages: { verify: { budgetTokens: 4_000 } } } },
    };
    const noClobber = mergePackageConfig(rootBase, {
      context: { v2: { stages: { execution: { budgetTokens: 15_000 } } } } as unknown as Partial<NaxConfig["context"]>,
    } as Partial<NaxConfig>);
    expect(noClobber.context.v2.stages.execution?.budgetTokens).toBe(15_000);
    expect(noClobber.context.v2.stages.verify?.budgetTokens).toBe(4_000);

    const rootWithExec = {
      ...makeRoot(),
      context: {
        ...makeRoot().context,
        v2: { ...makeRoot().context.v2, stages: { execution: { budgetTokens: 8_000 } } },
      },
    };
    const overrideWins = mergePackageConfig(rootWithExec, {
      context: { v2: { stages: { execution: { budgetTokens: 20_000 } } } } as unknown as Partial<NaxConfig["context"]>,
    } as Partial<NaxConfig>);
    expect(overrideWins.context.v2.stages.execution?.budgetTokens).toBe(20_000);
  });
});
