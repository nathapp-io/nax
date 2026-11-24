/**
 * Quality Test Command Resolver
 *
 * Single source of truth for resolving quality test commands across pipeline stages.
 * Handles: review.commands.test ?? quality.commands.test priority, {{package}} resolution,
 * and monorepo orchestrator promotion (turbo/nx → scoped template becomes testCommand).
 */

import { join } from "node:path";
import {
  commandSpecIncludes,
  type QualityCommandSpec,
  replaceInCommandSpec,
  shellQuoteArg,
} from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "../config";
import { isMonorepoOrchestratorCommand } from "../test-runners";

export interface ResolvedTestCommands {
  /**
   * Configured base command (review.commands.test ?? quality.commands.test).
   * undefined = no test command configured; callers should skip testing.
   */
  rawTestCommand: QualityCommandSpec | undefined;
  /**
   * Effective command after orchestrator promotion.
   * - Non-orchestrators: same as rawTestCommand.
   * - Orchestrators with storyWorkdir set: the resolved testScoped template (e.g. "bunx turbo test --filter=@pkg").
   * - Orchestrators without storyWorkdir: same as rawTestCommand (full suite).
   */
  testCommand: QualityCommandSpec | undefined;
  /**
   * Resolved testScoped template ({{package}} substituted for monorepo stories).
   * undefined for monorepo orchestrators (cleared after promotion — they scope natively).
   * undefined when no testScoped command is configured.
   */
  testScopedTemplate: QualityCommandSpec | undefined;
  /** True when rawTestCommand is a monorepo orchestrator (turbo/nx). */
  isMonorepoOrchestrator: boolean;
  /** Max failing files before falling back to the full suite (quality.scopeTestThreshold). */
  scopeFileThreshold: number;
}

/** Injectable deps for testability — avoids mock.module() contamination */
export const _commandResolverDeps = {
  readPackageName: async (dir: string): Promise<string | null> => {
    try {
      const content = await Bun.file(join(dir, "package.json")).json();
      return typeof content.name === "string" ? content.name : null;
    } catch {
      return null;
    }
  },
};

/** The pair a promotion yields: the command to run, and the template left for per-file expansion. */
export interface PromotedTestCommands {
  readonly testCommand: QualityCommandSpec | undefined;
  readonly testScopedTemplate: QualityCommandSpec | undefined;
}

/**
 * Resolve a `{{package}}` template and, for a monorepo orchestrator, promote the
 * resolved template to the command to run.
 *
 * Extracted from `resolveQualityTestCommands` so `verifyScopedOp` can apply the
 * same promotion to the command it was about to run (US-004): an orchestrator
 * scopes natively through its own filter syntax, so appending individual file
 * paths would be invalid — and running the raw repo-wide command would verify
 * every package instead of the story's.
 *
 * @param testCommand  - The command as configured (review.commands.test ?? quality.commands.test)
 * @param scopedTemplate - quality.commands.testScoped, as configured
 * @param workdir      - ABSOLUTE package directory used for the package.json name lookup
 * @param storyWorkdir - the package's key relative to the repo root (e.g. "packages/nax").
 *                       Not the lookup directory; undefined at the repo root, where no
 *                       promotion happens.
 */
export async function promoteOrchestratorCommand(
  testCommand: QualityCommandSpec | undefined,
  scopedTemplate: QualityCommandSpec | undefined,
  workdir: string,
  storyWorkdir: string | undefined,
): Promise<PromotedTestCommands> {
  const isMonorepoOrchestrator = testCommand ? isMonorepoOrchestratorCommand(testCommand) : false;

  // Resolve {{package}} in the scoped template. Returns null if package.json is
  // absent (non-JS project) — callers then run the raw command.
  let resolvedScopedTemplate = scopedTemplate;
  if (scopedTemplate !== undefined && commandSpecIncludes(scopedTemplate, "{{package}}") && storyWorkdir) {
    const pkgName = await _commandResolverDeps.readPackageName(workdir);
    resolvedScopedTemplate =
      pkgName !== null ? replaceInCommandSpec(scopedTemplate, "{{package}}", shellQuoteArg(pkgName)) : undefined;
  }

  // Monorepo orchestrator promotion: turbo/nx handle scoping natively via their own filter syntax.
  if (!isMonorepoOrchestrator) return { testCommand, testScopedTemplate: resolvedScopedTemplate };

  return {
    testCommand: resolvedScopedTemplate && storyWorkdir ? resolvedScopedTemplate : testCommand,
    // never do per-file expansion for orchestrators
    testScopedTemplate: undefined,
  };
}

/**
 * Resolve quality test commands for a story, applying:
 * 1. review.commands.test ?? quality.commands.test priority
 * 2. {{package}} resolution in testScoped template (monorepo stories)
 * 3. Monorepo orchestrator promotion (turbo/nx + storyWorkdir → scoped template becomes testCommand)
 *
 * @param config       - Project config
 * @param workdir      - Resolved package directory (already resolved per MW-006)
 * @param storyWorkdir - storyPackageDir(story) — the package for a monorepo story,
 *                       undefined at the repo root. Never pass the raw field: it is
 *                       "." at the root, which is truthy, and the branches below would
 *                       then promote a root story to the monorepo orchestrator path.
 */
export async function resolveQualityTestCommands(
  config: Pick<NaxConfig, "review" | "quality">,
  workdir: string,
  storyWorkdir?: string,
): Promise<ResolvedTestCommands> {
  const rawTestCommand = config.review?.commands?.test ?? config.quality?.commands?.test;
  const rawScopedTemplate = config.quality?.commands?.testScoped;
  const scopeFileThreshold = config.quality?.scopeTestThreshold ?? 10;
  const isMonorepoOrchestrator = rawTestCommand ? isMonorepoOrchestratorCommand(rawTestCommand) : false;

  // {{package}} substitution + orchestrator promotion live in one helper so
  // verify-scoped applies exactly the same rules to the command it runs.
  const { testCommand, testScopedTemplate } = await promoteOrchestratorCommand(
    rawTestCommand,
    rawScopedTemplate,
    workdir,
    storyWorkdir,
  );

  return { rawTestCommand, testCommand, testScopedTemplate, isMonorepoOrchestrator, scopeFileThreshold };
}
