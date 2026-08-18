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
 * Deep-merge per-agent model tier maps. A package override of one agent's
 * tiers (e.g. `models.claude.fast`) must not drop that agent's other tiers
 * from root, nor drop agents that root defines but the override doesn't
 * mention. Merges each agent key present in either root or the override.
 */
function mergeModels(rootModels: NaxConfig["models"], overrideModels: NaxConfig["models"]): NaxConfig["models"] {
  const agents = new Set([...Object.keys(rootModels ?? {}), ...Object.keys(overrideModels ?? {})]);
  const merged: NaxConfig["models"] = {};
  for (const agent of agents) {
    merged[agent] = { ...rootModels?.[agent], ...overrideModels?.[agent] };
  }
  return merged;
}

/**
 * Merge a package-level partial config override into a root config.
 *
 * Mergeable sections:
 * - agent: protocol, maxInteractionTurns, promptAudit (deep)
 * - models: per-agent model tier mappings (deep)
 * - routing: strategy, llm (deep)
 * - execution: smartTestRunner, regressionGate (deep), flakeDetection (deep),
 *   mutationCheck (deep), rectification (deep), verificationTimeoutSeconds,
 *   worktreeDependencies (deep)
 * - review: enabled, checks, commands (deep), semantic (deep), adversarial (deep)
 * - acceptance: enabled, testPath, fix (deep)
 * - quality: commands (deep), testing (deep), autofix (deep), lintOutput (deep)
 * - context: testCoverage (deep), v2.stages (deep), v2.rules (deep)
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
    packageOverride.agent != null ||
    packageOverride.models != null ||
    packageOverride.routing != null ||
    packageOverride.execution != null ||
    packageOverride.review != null ||
    packageOverride.acceptance != null ||
    packageOverride.quality != null ||
    packageOverride.context != null ||
    packageOverride.project != null;

  if (!hasAnyMergeableField) {
    return root;
  }

  return {
    ...root,
    agent:
      packageOverride.agent != null
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
    models: packageOverride.models != null ? mergeModels(root.models, packageOverride.models) : root.models,
    routing:
      packageOverride.routing != null
        ? { ...root.routing, ...packageOverride.routing, llm: { ...root.routing?.llm, ...packageOverride.routing.llm } }
        : root.routing,
    execution: {
      ...root.execution,
      ...packageOverride.execution,
      worktreeDependencies:
        packageOverride.execution?.worktreeDependencies !== undefined
          ? {
              ...root.execution.worktreeDependencies,
              ...packageOverride.execution.worktreeDependencies,
            }
          : root.execution.worktreeDependencies,
      smartTestRunner: packageOverride.execution?.smartTestRunner ?? root.execution.smartTestRunner,
      regressionGate: {
        ...root.execution.regressionGate,
        ...packageOverride.execution?.regressionGate,
      },
      verificationTimeoutSeconds:
        packageOverride.execution?.verificationTimeoutSeconds ?? root.execution.verificationTimeoutSeconds,
      flakeDetection: {
        ...root.execution.flakeDetection,
        ...packageOverride.execution?.flakeDetection,
      },
      mutationCheck: {
        ...root.execution.mutationCheck,
        ...packageOverride.execution?.mutationCheck,
      },
      rectification: {
        ...root.execution.rectification,
        ...packageOverride.execution?.rectification,
      },
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
        ...(packageOverride.quality?.commands?.lintScoped !== undefined && {
          lintScoped: packageOverride.quality.commands.lintScoped,
        }),
        ...(packageOverride.quality?.commands?.lintFix !== undefined && {
          lintFix: packageOverride.quality.commands.lintFix,
        }),
        ...(packageOverride.quality?.commands?.lintFixScoped !== undefined && {
          lintFixScoped: packageOverride.quality.commands.lintFixScoped,
        }),
        ...(packageOverride.quality?.commands?.formatFix !== undefined && {
          formatFix: packageOverride.quality.commands.formatFix,
        }),
        ...(packageOverride.quality?.commands?.formatFixScoped !== undefined && {
          formatFixScoped: packageOverride.quality.commands.formatFixScoped,
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
      adversarial:
        packageOverride.review?.adversarial !== undefined
          ? { ...root.review.adversarial, ...packageOverride.review.adversarial }
          : root.review.adversarial,
    },
    acceptance: {
      ...root.acceptance,
      ...packageOverride.acceptance,
      fix:
        packageOverride.acceptance?.fix !== undefined
          ? { ...root.acceptance.fix, ...packageOverride.acceptance.fix }
          : root.acceptance.fix,
    },
    quality: {
      ...root.quality,
      commands: {
        ...root.quality.commands,
        ...packageOverride.quality?.commands,
      },
      // ENH-010: deep-merge testing config so per-package overrides work
      testing:
        packageOverride.quality?.testing !== undefined
          ? { ...root.quality.testing, ...packageOverride.quality.testing }
          : root.quality.testing,
      autofix:
        packageOverride.quality?.autofix !== undefined
          ? { ...root.quality.autofix, ...packageOverride.quality.autofix }
          : root.quality.autofix,
      lintOutput:
        packageOverride.quality?.lintOutput !== undefined
          ? { ...root.quality.lintOutput, ...packageOverride.quality.lintOutput }
          : root.quality.lintOutput,
    },
    context: {
      ...root.context,
      testCoverage: {
        ...root.context.testCoverage,
        ...packageOverride.context?.testCoverage,
      },
      v2: {
        ...root.context.v2,
        // AC-59: per-package stage budget overrides — deep-merge so each package
        // can independently override individual stage budgets without clobbering others.
        stages: {
          ...root.context.v2?.stages,
          ...packageOverride.context?.v2?.stages,
        },
        rules: {
          ...root.context.v2?.rules,
          ...packageOverride.context?.v2?.rules,
        },
      },
    },
    project: packageOverride.project !== undefined ? { ...root.project, ...packageOverride.project } : root.project,
  };
}
