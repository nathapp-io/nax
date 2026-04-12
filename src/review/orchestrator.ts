/**
 * Review Orchestrator (ADR-005, Phase 2)
 *
 * Single entry point for all post-implementation review. Delegates to the
 * review runner and plugin reviewers. Provides a unified result.
 *
 * Usage:
 *   const result = await reviewOrchestrator.review(config, workdir, executionConfig, plugins);
 */

import { spawn } from "bun";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import type { ModelTier } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import { errorMessage } from "../utils/errors";
import { runAdversarialReview } from "./adversarial";
import { runReview } from "./runner";
import type { SemanticStory } from "./semantic";
import { runSemanticReview } from "./semantic";
import type { AdversarialReviewConfig, ReviewCheckResult, ReviewConfig, ReviewResult } from "./types";

/**
 * Injectable dependencies for getChangedFiles() — allows tests to intercept
 * spawn calls without requiring the git binary.
 *
 * @internal
 */
export const _orchestratorDeps = { spawn };

async function getChangedFiles(workdir: string, baseRef?: string): Promise<string[]> {
  try {
    const diffArgs = ["diff", "--name-only"];
    const [stagedProc, unstagedProc, baseProc] = [
      _orchestratorDeps.spawn({ cmd: ["git", ...diffArgs, "--cached"], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
      _orchestratorDeps.spawn({ cmd: ["git", ...diffArgs], cwd: workdir, stdout: "pipe", stderr: "pipe" }),
      baseRef
        ? _orchestratorDeps.spawn({
            cmd: ["git", ...diffArgs, `${baseRef}...HEAD`],
            cwd: workdir,
            stdout: "pipe",
            stderr: "pipe",
          })
        : null,
    ];

    await Promise.all([stagedProc.exited, unstagedProc.exited, baseProc?.exited]);

    const [staged, unstaged, based] = await Promise.all([
      new Response(stagedProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean)),
      new Response(unstagedProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean)),
      baseProc
        ? new Response(baseProc.stdout).text().then((t) => t.trim().split("\n").filter(Boolean))
        : Promise.resolve([]),
    ]);

    return Array.from(new Set([...staged, ...unstaged, ...based]));
  } catch {
    return [];
  }
}

export interface OrchestratorReviewResult {
  /** Built-in review result (typecheck, lint, format) */
  builtIn: ReviewResult;
  /** Whether ALL checks passed (built-in + plugin reviewers) */
  success: boolean;
  /** Failure reason if success === false */
  failureReason?: string;
  /** Plugin reviewer hard-failure flag (determines escalate vs fail) */
  pluginFailed: boolean;
  /**
   * True when only mechanical checks failed (build/typecheck/lint) but LLM checks
   * (semantic/adversarial) passed. Signals to autofix that the code is functionally
   * correct and UNRESOLVED should not trigger tier escalation.
   */
  mechanicalFailedOnly?: boolean;
}

export class ReviewOrchestrator {
  /** Run built-in checks + plugin reviewers. Returns unified result. */
  async review(
    reviewConfig: ReviewConfig,
    workdir: string,
    executionConfig: NaxConfig["execution"],
    plugins?: PluginRegistry,
    storyGitRef?: string,
    scopePrefix?: string,
    qualityCommands?: NaxConfig["quality"]["commands"],
    storyId?: string,
    story?: SemanticStory,
    modelResolver?: (tier: ModelTier) => AgentAdapter | null | undefined,
    naxConfig?: NaxConfig,
    retrySkipChecks?: Set<string>,
    featureName?: string,
    resolverSession?: import("./dialogue").ReviewerSession,
    priorFailures?: Array<{ stage: string; modelTier: string }>,
  ): Promise<OrchestratorReviewResult> {
    const logger = getSafeLogger();

    // Detect which LLM-based reviewers are active (groundwork for Phase 4 parallel dispatch).
    const hasSemantic = reviewConfig.checks.includes("semantic");
    const hasAdversarial = reviewConfig.checks.includes("adversarial");

    const hasLLMChecks = hasSemantic || hasAdversarial;

    if (hasLLMChecks) {
      const active = [hasSemantic ? "semantic" : null, hasAdversarial ? "adversarial" : null]
        .filter(Boolean)
        .join(", ");
      logger?.debug("review", `LLM reviewers active: ${active}`, { storyId });
    }

    // Phase 4: Parallel dispatch for semantic + adversarial when advConfig.parallel === true
    // and the combined session count does not exceed maxConcurrentSessions.
    const advConfig = reviewConfig.adversarial;
    const canParallelize = (() => {
      if (!hasSemantic || !hasAdversarial || !advConfig?.parallel) return false;
      const semSessions =
        naxConfig?.debate?.enabled && naxConfig?.debate?.stages?.review?.enabled
          ? (naxConfig.debate.stages.review.debaters?.length ?? 2) + 1
          : 1;
      const advSessions = 1;
      const cap = advConfig.maxConcurrentSessions ?? 2;
      if (semSessions + advSessions > cap) {
        logger?.warn("review", "Parallel mode disabled — session cap exceeded", {
          storyId,
          semSessions,
          advSessions,
          cap,
        });
        return false;
      }
      return true;
    })();

    let builtIn: ReviewResult;
    let mechanicalFailedOnly: boolean | undefined;

    if (!hasLLMChecks) {
      // No LLM checks configured — run everything flat (backward compatible)
      builtIn = await runReview(
        reviewConfig,
        workdir,
        executionConfig,
        qualityCommands,
        storyId,
        storyGitRef,
        story,
        modelResolver,
        naxConfig,
        retrySkipChecks,
        featureName,
        resolverSession,
        priorFailures,
      );
    } else {
      // Always split: mechanical checks first, then LLM checks independently.
      // This prevents mechanical failures (e.g. lint in a test file the agent cannot touch)
      // from blocking semantic/adversarial review — and signals to autofix that the code
      // is functionally correct when LLM checks pass despite mechanical failures.
      const mechanicalCheckNames = reviewConfig.checks.filter((c) => c !== "semantic" && c !== "adversarial");
      const llmCheckNames = reviewConfig.checks.filter(
        (c): c is "semantic" | "adversarial" => c === "semantic" || c === "adversarial",
      );

      // Step 1: Run mechanical checks (fail-fast preserved within mechanical)
      const mechanicalConfig = { ...reviewConfig, checks: mechanicalCheckNames };
      const mechanicalResult = await runReview(
        mechanicalConfig,
        workdir,
        executionConfig,
        qualityCommands,
        storyId,
        storyGitRef,
        story,
        modelResolver,
        naxConfig,
        retrySkipChecks,
        featureName,
        resolverSession,
        priorFailures,
      );

      // Step 2: Run LLM checks regardless of mechanical result (fail-fast within LLM)
      const llmStart = Date.now();
      let llmCheckResults: ReviewCheckResult[];

      if (canParallelize) {
        // semantic + adversarial concurrently
        const semanticStory: SemanticStory = {
          id: storyId ?? "",
          title: story?.title ?? "",
          description: story?.description ?? "",
          acceptanceCriteria: story?.acceptanceCriteria ?? [],
        };
        const semanticCfg = reviewConfig.semantic ?? {
          modelTier: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [] as string[],
          timeoutMs: 600_000,
          excludePatterns: [] as string[],
        };
        // advConfig is guaranteed non-null here: canParallelize required advConfig?.parallel === true
        const adversarialCfg: AdversarialReviewConfig = advConfig as AdversarialReviewConfig;

        logger?.debug("review", "Running semantic + adversarial in parallel", { storyId });
        const [semResult, advResult] = await Promise.all([
          runSemanticReview(
            workdir,
            storyGitRef,
            semanticStory,
            semanticCfg,
            modelResolver ?? (() => null),
            naxConfig,
            featureName,
            resolverSession,
            priorFailures,
          ),
          runAdversarialReview(
            workdir,
            storyGitRef,
            semanticStory,
            adversarialCfg,
            modelResolver ?? (() => null),
            naxConfig,
            featureName,
            priorFailures,
          ),
        ]);
        llmCheckResults = [semResult, advResult];
      } else {
        // Sequential LLM run via runReview (handles semantic and adversarial in-loop)
        const llmConfig = { ...reviewConfig, checks: llmCheckNames };
        const llmResult = await runReview(
          llmConfig,
          workdir,
          executionConfig,
          qualityCommands,
          storyId,
          storyGitRef,
          story,
          modelResolver,
          naxConfig,
          retrySkipChecks,
          featureName,
          resolverSession,
          priorFailures,
        );
        llmCheckResults = llmResult.checks;
      }

      const allChecks = [...mechanicalResult.checks, ...llmCheckResults];
      const mechanicalPassed = mechanicalResult.success;
      const llmPassed = llmCheckResults.every((c) => c.success);
      const firstFailure = allChecks.find((c) => !c.success);
      const failureReason = firstFailure
        ? firstFailure.check === "semantic" || firstFailure.check === "adversarial"
          ? `${firstFailure.check} failed`
          : `${firstFailure.check} failed (exit code ${firstFailure.exitCode})`
        : undefined;

      builtIn = {
        success: mechanicalPassed && llmPassed,
        checks: allChecks,
        totalDurationMs: mechanicalResult.totalDurationMs + (Date.now() - llmStart),
        failureReason,
      };

      // Signal to autofix that code is functionally correct (LLM passed) despite mechanical failure
      mechanicalFailedOnly = !mechanicalPassed && llmPassed;
    }

    if (!builtIn.success) {
      return {
        builtIn,
        success: false,
        failureReason: builtIn.failureReason,
        pluginFailed: false,
        mechanicalFailedOnly,
      };
    }

    if (reviewConfig.pluginMode === "deferred") {
      logger?.debug("review", "Plugin reviewers deferred — skipping per-story execution");
      return { builtIn, success: true, pluginFailed: false };
    }

    if (plugins) {
      const reviewers = plugins.getReviewers();
      if (reviewers.length > 0) {
        // Use the story's start ref if available to capture auto-committed changes
        const baseRef = storyGitRef ?? executionConfig?.storyGitRef;
        const changedFiles = await getChangedFiles(workdir, baseRef);
        const scopedFiles = scopePrefix
          ? changedFiles.filter((f) => f === scopePrefix || f.startsWith(`${scopePrefix}/`))
          : changedFiles;
        const pluginResults: ReviewResult["pluginReviewers"] = [];

        for (const reviewer of reviewers) {
          logger?.info("review", `Running plugin reviewer: ${reviewer.name}`, {
            changedFiles: scopedFiles.length,
          });
          try {
            const result = await reviewer.check(workdir, scopedFiles);
            // Always log the result so skips/passes are visible in the log
            logger?.info("review", `Plugin reviewer result: ${reviewer.name}`, {
              passed: result.passed,
              exitCode: result.exitCode,
              output: result.output?.slice(0, 500),
              findings: result.findings?.length ?? 0,
            });
            pluginResults.push({
              name: reviewer.name,
              passed: result.passed,
              output: result.output,
              exitCode: result.exitCode,
              findings: result.findings,
            });
            if (!result.passed) {
              builtIn.pluginReviewers = pluginResults;
              return {
                builtIn,
                success: false,
                failureReason: `plugin reviewer '${reviewer.name}' failed`,
                pluginFailed: true,
              };
            }
          } catch (error) {
            const errorMsg = errorMessage(error);
            logger?.warn("review", `Plugin reviewer threw error: ${reviewer.name}`, { error: errorMsg });
            pluginResults.push({ name: reviewer.name, passed: false, output: "", error: errorMsg });
            builtIn.pluginReviewers = pluginResults;
            return {
              builtIn,
              success: false,
              failureReason: `plugin reviewer '${reviewer.name}' threw error`,
              pluginFailed: true,
            };
          }
        }
        builtIn.pluginReviewers = pluginResults;
      }
    }

    return { builtIn, success: true, pluginFailed: false };
  }

  /**
   * Run review with a PipelineContext — reads all inputs from ctx.
   * Preferred API for pipeline stages.
   *
   * Consumes ctx.retrySkipChecks once (clears it after reading) so
   * subsequent retries re-evaluate all checks.
   */
  reviewFromContext(ctx: PipelineContext): Promise<OrchestratorReviewResult> {
    // #136: Consume retrySkipChecks once — cleared so subsequent retries re-evaluate
    const retrySkipChecks = ctx.retrySkipChecks;
    ctx.retrySkipChecks = undefined;

    const agentResolver = ctx.agentGetFn ?? undefined;
    const agentName = ctx.rootConfig.autoMode?.defaultAgent;
    const modelResolver = agentName
      ? (_tier: string) => (agentResolver ? (agentResolver(agentName) ?? null) : null)
      : undefined;

    // When debate+dialogue are both enabled, pass the existing ReviewerSession as the resolver
    // session so runSemanticReview() can thread it through to the DebateSession.
    const reviewDebateEnabled = ctx.rootConfig?.debate?.enabled && ctx.rootConfig?.debate?.stages?.review?.enabled;
    const resolverSession = reviewDebateEnabled ? ctx.reviewerSession : undefined;

    return this.review(
      ctx.config.review,
      ctx.workdir,
      ctx.config.execution,
      ctx.plugins,
      ctx.storyGitRef,
      ctx.story.workdir, // relative path for git diff scoping (unchanged)
      ctx.config.quality?.commands,
      ctx.story.id,
      {
        id: ctx.story.id,
        title: ctx.story.title,
        description: ctx.story.description,
        acceptanceCriteria: ctx.story.acceptanceCriteria,
      },
      modelResolver,
      ctx.config,
      retrySkipChecks,
      ctx.prd.feature,
      resolverSession,
      ctx.story.priorFailures,
    );
  }
}

export const reviewOrchestrator = new ReviewOrchestrator();
