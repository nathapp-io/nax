/**
 * Per-Package Config Merge Utility (MW-008, v0.49.0 expansion)
 *
 * Merges a package-level partial config override into a root config.
 * Covers all fields that make sense at the per-package level.
 * Root-only fields (autoMode, generate, tdd, decompose, plan, constitution,
 * interaction) are unchanged.
 */

import type { NaxConfig } from "./schema";

/**
 * Merge a package-level partial config override into a root config.
 *
 * Mergeable sections:
 * - agent: protocol, maxInteractionTurns, promptAudit (deep)
 * - models: per-agent model tier mappings (deep)
 * - routing: strategy, llm (deep)
 * - execution: smartTestRunner, regressionGate (deep), verificationTimeoutSeconds
 * - review: enabled, checks, commands (deep), pluginMode, semantic (deep)
 * - acceptance: enabled, generateTests, testPath
 * - quality: requireTests, requireTypecheck, requireLint, commands (deep), testing (deep)
 * - context: testCoverage (deep)
 * - project: type, language, frameworks
 *
 * Root-only sections (autoMode, generate, tdd, decompose, plan, constitution,
 * interaction) are never overridden by package-level config.
 *
 * @param root - Full root NaxConfig (already validated)
 * @param packageOverride - Partial package-level override
 * @returns New merged NaxConfig (immutable — does not mutate inputs)
 */
export function mergePackageConfig(root: NaxConfig, packageOverride: Partial<NaxConfig>): NaxConfig {
  const hasAnyMergeableField =
    packageOverride.agent !== undefined ||
    packageOverride.models !== undefined ||
    packageOverride.routing !== undefined ||
    packageOverride.execution !== undefined ||
    packageOverride.review !== undefined ||
    packageOverride.acceptance !== undefined ||
    packageOverride.quality !== undefined ||
    packageOverride.context !== undefined ||
    packageOverride.project !== undefined;

  if (!hasAnyMergeableField) {
    return root;
  }

  return {
    ...root,
    agent:
      packageOverride.agent !== undefined
        ? {
            ...root.agent,
            ...packageOverride.agent,
            promptAudit: {
              enabled: packageOverride.agent.promptAudit?.enabled ?? root.agent?.promptAudit?.enabled ?? false,
              ...(packageOverride.agent.promptAudit?.dir !== undefined
                ? { dir: packageOverride.agent.promptAudit.dir }
                : root.agent?.promptAudit?.dir !== undefined
                  ? { dir: root.agent.promptAudit.dir }
                  : {}),
            },
          }
        : root.agent,
    models: packageOverride.models !== undefined ? { ...root.models, ...packageOverride.models } : root.models,
    routing:
      packageOverride.routing !== undefined
        ? { ...root.routing, ...packageOverride.routing, llm: { ...root.routing?.llm, ...packageOverride.routing.llm } }
        : root.routing,
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
        ...(packageOverride.quality?.commands?.build !== undefined && {
          build: packageOverride.quality.commands.build,
        }),
        // Explicit review.commands override bridged quality values
        ...packageOverride.review?.commands,
      },
      // Deep merge semantic config for per-package overrides
      semantic:
        packageOverride.review?.semantic !== undefined
          ? { ...root.review.semantic, ...packageOverride.review.semantic }
          : root.review.semantic,
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
      // ENH-010: deep-merge testing config so per-package overrides work
      testing:
        packageOverride.quality?.testing !== undefined
          ? { ...root.quality.testing, ...packageOverride.quality.testing }
          : root.quality.testing,
    },
    context: {
      ...root.context,
      testCoverage: {
        ...root.context.testCoverage,
        ...packageOverride.context?.testCoverage,
      },
    },
    project: packageOverride.project !== undefined ? { ...root.project, ...packageOverride.project } : root.project,
  };
}
