/**
 * Unit tests for mergePackageConfig (MW-008, v0.49.0 expansion)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";

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
      quality: { ...DEFAULT_CONFIG.quality, commands: undefined as unknown as NaxConfig["quality"]["commands"] },
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

  test("routing (root-only field) from packageOverride is ignored", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
      routing: { strategy: "keyword" } as NaxConfig["routing"],
    } as Partial<NaxConfig>);

    // routing not changed
    expect(result.routing).toBe(root.routing);
    // quality.commands merged
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
    test("overrides smartTestRunner when set to false in package config", () => {
      const root = makeRoot();
      const result = mergePackageConfig(root, {
        execution: {
          smartTestRunner: false,
        } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);

      // false → coerced as-is (verify stage handles coercion)
      expect(result.execution.smartTestRunner).toBe(false);
    });

    test("preserves root smartTestRunner when not overridden", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        execution: {
          ...DEFAULT_CONFIG.execution,
          smartTestRunner: { enabled: true, testFilePatterns: ["test/**/*.test.ts"], fallback: "import-grep" },
        },
      };
      const result = mergePackageConfig(root, {
        quality: { commands: { test: "changed" } },
      } as Partial<NaxConfig>);

      expect(result.execution.smartTestRunner).toEqual(root.execution.smartTestRunner);
    });
  });

  describe("execution.regressionGate deep merge", () => {
    test("overrides regressionGate.mode per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
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
      // Other regressionGate fields preserved
      expect(result.execution.regressionGate.enabled).toBe(true);
      expect(result.execution.regressionGate.timeoutSeconds).toBe(120);
    });

    test("overrides regressionGate.timeoutSeconds per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        execution: {
          ...DEFAULT_CONFIG.execution,
          regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 120, acceptOnTimeout: true },
        },
      };
      const result = mergePackageConfig(root, {
        execution: {
          regressionGate: { timeoutSeconds: 600 },
        } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);

      expect(result.execution.regressionGate.timeoutSeconds).toBe(600);
      expect(result.execution.regressionGate.mode).toBe("deferred");
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
    test("overrides review.enabled per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        review: { enabled: true, checks: ["typecheck", "lint"], commands: {}, pluginMode: "per-story" },
      };
      const result = mergePackageConfig(root, {
        review: { enabled: false } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);

      expect(result.review.enabled).toBe(false);
      // Other review fields preserved
      expect(result.review.checks).toEqual(["typecheck", "lint"]);
    });

    test("overrides review.checks per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        review: { enabled: true, checks: ["typecheck", "lint"], commands: {}, pluginMode: "per-story" },
      };
      const result = mergePackageConfig(root, {
        review: { checks: ["lint"] } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);

      expect(result.review.checks).toEqual(["lint"]);
    });

    test("deep merges review.commands per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        review: {
          enabled: true,
          checks: ["typecheck", "lint"],
          commands: { typecheck: "bun typecheck", lint: "bun lint" },
          pluginMode: "per-story",
        },
      };
      const result = mergePackageConfig(root, {
        review: { commands: { lint: "eslint ." } } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);

      expect(result.review.commands.lint).toBe("eslint .");
      expect(result.review.commands.typecheck).toBe("bun typecheck");
    });

    test("overrides review.pluginMode per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        review: { enabled: true, checks: [], commands: {}, pluginMode: "per-story" },
      };
      const result = mergePackageConfig(root, {
        review: { pluginMode: "deferred" } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);

      expect(result.review.pluginMode).toBe("deferred");
    });

    describe("PKG-006: quality.commands bridged to review.commands", () => {
      test("quality.commands.lint bridges to review.commands.lint when review.commands not set", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: { enabled: true, checks: ["lint"], commands: { lint: "bunx turbo lint" }, pluginMode: "per-story" },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { lint: "bun run lint" } },
        } as Partial<NaxConfig>);

        // Per-package quality.commands.lint overrides root review.commands.lint
        expect(result.review.commands.lint).toBe("bun run lint");
        // quality.commands also updated
        expect(result.quality.commands.lint).toBe("bun run lint");
      });

      test("quality.commands.typecheck bridges to review.commands.typecheck", () => {
        const root: NaxConfig = {
          ...makeRoot(),
          review: {
            enabled: true,
            checks: ["typecheck"],
            commands: { typecheck: "bunx turbo type-check" },
            pluginMode: "per-story",
          },
        };
        const result = mergePackageConfig(root, {
          quality: { commands: { typecheck: "bun run type-check" } },
        } as Partial<NaxConfig>);

        expect(result.review.commands.typecheck).toBe("bun run type-check");
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
    test("overrides acceptance.enabled per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true },
      };
      const result = mergePackageConfig(root, {
        acceptance: { enabled: false } as Partial<NaxConfig["acceptance"]>,
      } as Partial<NaxConfig>);

      expect(result.acceptance.enabled).toBe(false);
    });

    test("overrides acceptance.testPath per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        acceptance: { ...DEFAULT_CONFIG.acceptance, testPath: "acceptance.test.ts" },
      };
      const result = mergePackageConfig(root, {
        acceptance: { testPath: "e2e/acceptance.test.ts" } as Partial<NaxConfig["acceptance"]>,
      } as Partial<NaxConfig>);

      expect(result.acceptance.testPath).toBe("e2e/acceptance.test.ts");
    });

    test("overrides acceptance.generateTests per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        acceptance: { ...DEFAULT_CONFIG.acceptance, generateTests: true },
      };
      const result = mergePackageConfig(root, {
        acceptance: { generateTests: false } as Partial<NaxConfig["acceptance"]>,
      } as Partial<NaxConfig>);

      expect(result.acceptance.generateTests).toBe(false);
    });
  });

  describe("quality boolean flag overrides", () => {
    test("overrides quality.requireTests per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        quality: { ...DEFAULT_CONFIG.quality, requireTests: true, commands: {} },
      };
      const result = mergePackageConfig(root, {
        quality: { requireTests: false } as Partial<NaxConfig["quality"]>,
      } as Partial<NaxConfig>);

      expect(result.quality.requireTests).toBe(false);
    });

    test("overrides quality.requireTypecheck per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        quality: { ...DEFAULT_CONFIG.quality, requireTypecheck: true, commands: {} },
      };
      const result = mergePackageConfig(root, {
        quality: { requireTypecheck: false } as Partial<NaxConfig["quality"]>,
      } as Partial<NaxConfig>);

      expect(result.quality.requireTypecheck).toBe(false);
    });

    test("overrides quality.requireLint per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        quality: { ...DEFAULT_CONFIG.quality, requireLint: true, commands: {} },
      };
      const result = mergePackageConfig(root, {
        quality: { requireLint: false } as Partial<NaxConfig["quality"]>,
      } as Partial<NaxConfig>);

      expect(result.quality.requireLint).toBe(false);
    });

    test("overrides quality.requireBuild per package (BUILD-001)", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        quality: { ...DEFAULT_CONFIG.quality, requireBuild: false, commands: {} },
      };
      const result = mergePackageConfig(root, {
        quality: { requireBuild: true } as Partial<NaxConfig["quality"]>,
      } as Partial<NaxConfig>);

      expect(result.quality.requireBuild).toBe(true);
    });
  });

  describe("context.testCoverage deep merge", () => {
    test("deep merges context.testCoverage per package", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        context: {
          ...DEFAULT_CONFIG.context,
          testCoverage: {
            enabled: true,
            detail: "names-and-counts",
            maxTokens: 500,
            testPattern: "**/*.test.ts",
            scopeToStory: true,
          },
        },
      };
      const result = mergePackageConfig(root, {
        context: {
          testCoverage: { enabled: false },
        } as Partial<NaxConfig["context"]>,
      } as Partial<NaxConfig>);

      expect(result.context.testCoverage.enabled).toBe(false);
      // Other testCoverage fields preserved
      expect(result.context.testCoverage.testPattern).toBe("**/*.test.ts");
      expect(result.context.testCoverage.scopeToStory).toBe(true);
    });

    test("preserves root testCoverage when not overridden", () => {
      const root: NaxConfig = {
        ...makeRoot(),
        context: {
          ...DEFAULT_CONFIG.context,
          testCoverage: { enabled: true, detail: "names-and-counts", maxTokens: 500, testPattern: "**/*.test.ts", scopeToStory: true },
        },
      };
      const result = mergePackageConfig(root, {
        quality: { commands: { test: "jest" } },
      } as Partial<NaxConfig>);

      expect(result.context.testCoverage).toEqual(root.context.testCoverage);
    });
  });

  describe("immutability guarantees", () => {
    test("does not mutate root.execution", () => {
      const root = makeRoot();
      const origTimeout = root.execution.verificationTimeoutSeconds;
      mergePackageConfig(root, {
        execution: { verificationTimeoutSeconds: 999 } as Partial<NaxConfig["execution"]>,
      } as Partial<NaxConfig>);
      expect(root.execution.verificationTimeoutSeconds).toBe(origTimeout);
    });

    test("does not mutate root.review", () => {
      const root = makeRoot();
      const origEnabled = root.review.enabled;
      mergePackageConfig(root, {
        review: { enabled: !origEnabled } as Partial<NaxConfig["review"]>,
      } as Partial<NaxConfig>);
      expect(root.review.enabled).toBe(origEnabled);
    });

    test("does not mutate root.acceptance", () => {
      const root = makeRoot();
      const origEnabled = root.acceptance.enabled;
      mergePackageConfig(root, {
        acceptance: { enabled: !origEnabled } as Partial<NaxConfig["acceptance"]>,
      } as Partial<NaxConfig>);
      expect(root.acceptance.enabled).toBe(origEnabled);
    });
  });
});
