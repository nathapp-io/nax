/**
 * Per-Package Config Merge Utility (MW-008, v0.49.0 expansion)
 *
 * Merges a package-level partial config override into a root config.
 * Covers all fields that make sense at the per-package level.
 * Root-only fields (models, autoMode, routing, agent, etc.) are unchanged.
 */

import type { NaxConfig } from "./schema";

/**
 * Merge a package-level partial config override into a root config.
 *
 * Mergeable sections:
 * - execution: smartTestRunner, regressionGate (deep), verificationTimeoutSeconds
 * - review: enabled, checks, commands (deep), pluginMode
 * - acceptance: enabled, generateTests, testPath
 * - quality: requireTests, requireTypecheck, requireLint, commands (deep)
 * - context: testCoverage (deep)
 *
 * All other sections (models, autoMode, routing, agent, generate, tdd,
 * decompose, plan, constitution, interaction) remain root-only.
 *
 * @param root - Full root NaxConfig (already validated)
 * @param packageOverride - Partial package-level override
 * @returns New merged NaxConfig (immutable — does not mutate inputs)
 */
export function mergePackageConfig(root: NaxConfig, packageOverride: Partial<NaxConfig>): NaxConfig {
  const hasAnyMergeableField =
    packageOverride.execution !== undefined ||
    packageOverride.review !== undefined ||
    packageOverride.acceptance !== undefined ||
    packageOverride.quality !== undefined ||
    packageOverride.context !== undefined;

  if (!hasAnyMergeableField) {
    return root;
  }

  return {
    ...root,
    execution: {
      ...root.execution,
      ...packageOverride.execution,
      smartTestRunner: packageOverride.execution?.smartTestRunner ?? root.execution.smartTestRunner,
      regressionGate: {
        ...root.execution.regressionGate,
        ...packageOverride.execution?.regressionGate,
      },
      verificationTimeoutSeconds:
        packageOverride.execution?.verificationTimeoutSeconds ?? root.execution.verificationTimeoutSeconds,
    },
    review: {
      ...root.review,
      ...packageOverride.review,
      commands: {
        ...root.review.commands,
        // PKG-006: Bridge quality.commands → review.commands for per-package overrides.
        // Users naturally put per-package commands in quality.commands (the intuitive
        // place), but the review runner reads review.commands. Bridge them here so
        // packages don't need to define the same commands in two places.
        // Explicit review.commands still take precedence (applied after).
        ...(packageOverride.quality?.commands?.lint !== undefined && {
          lint: packageOverride.quality.commands.lint,
        }),
        ...(packageOverride.quality?.commands?.lintFix !== undefined && {
          lintFix: packageOverride.quality.commands.lintFix,
        }),
        ...(packageOverride.quality?.commands?.typecheck !== undefined && {
          typecheck: packageOverride.quality.commands.typecheck,
        }),
        ...(packageOverride.quality?.commands?.test !== undefined && {
          test: packageOverride.quality.commands.test,
        }),
        // Explicit review.commands override bridged quality values
        ...packageOverride.review?.commands,
      },
    },
    acceptance: {
      ...root.acceptance,
      ...packageOverride.acceptance,
    },
    quality: {
      ...root.quality,
      requireTests: packageOverride.quality?.requireTests ?? root.quality.requireTests,
      requireTypecheck: packageOverride.quality?.requireTypecheck ?? root.quality.requireTypecheck,
      requireLint: packageOverride.quality?.requireLint ?? root.quality.requireLint,
      commands: {
        ...root.quality.commands,
        ...packageOverride.quality?.commands,
      },
    },
    context: {
      ...root.context,
      testCoverage: {
        ...root.context.testCoverage,
        ...packageOverride.context?.testCoverage,
      },
    },
  };
}
