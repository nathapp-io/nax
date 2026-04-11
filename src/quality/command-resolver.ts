/**
 * Quality Test Command Resolver
 *
 * Single source of truth for resolving quality test commands across pipeline stages.
 * Handles: review.commands.test ?? quality.commands.test priority, {{package}} resolution,
 * and monorepo orchestrator promotion (turbo/nx → scoped template becomes testCommand).
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { isMonorepoOrchestratorCommand } from "../verification/strategies/scoped";

export interface ResolvedTestCommands {
  /**
   * Configured base command (review.commands.test ?? quality.commands.test).
   * undefined = no test command configured; callers should skip testing.
   */
  rawTestCommand: string | undefined;
  /**
   * Effective command after orchestrator promotion.
   * - Non-orchestrators: same as rawTestCommand.
   * - Orchestrators with storyWorkdir set: the resolved testScoped template (e.g. "bunx turbo test --filter=@pkg").
   * - Orchestrators without storyWorkdir: same as rawTestCommand (full suite).
   */
  testCommand: string | undefined;
  /**
   * Resolved testScoped template ({{package}} substituted for monorepo stories).
   * undefined for monorepo orchestrators (cleared after promotion — they scope natively).
   * undefined when no testScoped command is configured.
   */
  testScopedTemplate: string | undefined;
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

/**
 * Resolve quality test commands for a story, applying:
 * 1. review.commands.test ?? quality.commands.test priority
 * 2. {{package}} resolution in testScoped template (monorepo stories)
 * 3. Monorepo orchestrator promotion (turbo/nx + storyWorkdir → scoped template becomes testCommand)
 *
 * @param config       - Project config
 * @param workdir      - Resolved package directory (already resolved per MW-006)
 * @param storyWorkdir - story.workdir — set for monorepo stories, undefined for single-package
 */
export async function resolveQualityTestCommands(
  config: NaxConfig,
  workdir: string,
  storyWorkdir?: string,
): Promise<ResolvedTestCommands> {
  const rawTestCommand = config.review?.commands?.test ?? config.quality?.commands?.test;
  const rawScopedTemplate = config.quality?.commands?.testScoped;
  const scopeFileThreshold = config.quality?.scopeTestThreshold ?? 10;
  const isMonorepoOrchestrator = rawTestCommand ? isMonorepoOrchestratorCommand(rawTestCommand) : false;

  // Resolve {{package}} in testScoped template for monorepo stories.
  // Returns null if package.json is absent (non-JS project) — callers skip template.
  let resolvedScopedTemplate = rawScopedTemplate;
  if (rawScopedTemplate?.includes("{{package}}") && storyWorkdir) {
    const pkgName = await _commandResolverDeps.readPackageName(workdir);
    resolvedScopedTemplate = pkgName !== null ? rawScopedTemplate.replaceAll("{{package}}", pkgName) : undefined;
  }

  // Monorepo orchestrator promotion: turbo/nx handle scoping natively via their own filter syntax.
  // Appending individual file paths would produce invalid syntax for these tools.
  // When a resolved scoped template is available and story has a workdir, promote it to testCommand.
  let testCommand = rawTestCommand;
  let testScopedTemplate = resolvedScopedTemplate;
  if (isMonorepoOrchestrator) {
    if (resolvedScopedTemplate && storyWorkdir) {
      testCommand = resolvedScopedTemplate;
    }
    testScopedTemplate = undefined; // never do per-file expansion for orchestrators
  }

  return { rawTestCommand, testCommand, testScopedTemplate, isMonorepoOrchestrator, scopeFileThreshold };
}
