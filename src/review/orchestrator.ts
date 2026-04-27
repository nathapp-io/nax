/**
 * Review Orchestrator (ADR-005, Phase 2)
 *
 * Single entry point for all post-implementation review. Delegates to the
 * review runner and plugin reviewers. Provides a unified result.
 *
 * Usage:
 *   const result = await reviewOrchestrator.review(config, workdir, executionConfig, plugins);
 */

import { join } from "node:path";
import { spawn } from "bun";
import type { IAgentManager } from "../agents";
import type { NaxConfig } from "../config";
import { assembleForStage } from "../context/engine";
import type { ContextBundle } from "../context/engine";
import { getSafeLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import { errorMessage } from "../utils/errors";
import { type NaxIgnoreIndex, filterNaxInternalPaths, resolveNaxIgnorePatterns } from "../utils/path-filters";
import { runAdversarialReview } from "./adversarial";
import { runReview } from "./runner";
import type { SemanticStory } from "./semantic";
import { runSemanticReview } from "./semantic";
import type {
  AdversarialReviewConfig,
  ReviewCheckResult,
  ReviewConfig,
  ReviewResult,
  ReviewerFindingSummary,
} from "./types";
import { writeReviewVerdict } from "./verdict-writer";

/**
 * Injectable dependencies for orchestrator internals — allows tests to intercept
 * spawn and parallel LLM dispatch calls without mock.module() (BUG-035 pattern).
 *
 * @internal
 */
export const _orchestratorDeps = {
  spawn,
  runSemanticReview,
  runAdversarialReview,
};

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

/** Build per-reviewer finding summary from LLM check results. */
function buildReviewSummary(checks: ReviewCheckResult[]): ReviewResult["reviewSummary"] {
  const summary: ReviewResult["reviewSummary"] = {};
  const semCheck = checks.find((c) => c.check === "semantic");
  if (semCheck) {
    summary.semantic = {
      blocking: semCheck.findings?.length ?? 0,
      advisory: semCheck.advisoryFindings?.length ?? 0,
    } satisfies ReviewerFindingSummary;
  }
  const advCheck = checks.find((c) => c.check === "adversarial");
  if (advCheck) {
    summary.adversarial = {
      blocking: advCheck.findings?.length ?? 0,
      advisory: advCheck.advisoryFindings?.length ?? 0,
    } satisfies ReviewerFindingSummary;
  }
  return summary;
}

function formatFailureReason(check: ReviewCheckResult): string {
  return check.check === "semantic" || check.check === "adversarial"
    ? `${check.check} failed`
    : `${check.check} failed (exit code ${check.exitCode})`;
}

function buildFailureReason(checks: ReviewCheckResult[]): string | undefined {
  const failedChecks = checks.filter((check) => !check.success);
  if (failedChecks.length === 0) return undefined;
  return failedChecks.map(formatFailureReason).join(", ");
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
    agentManager?: IAgentManager,
    naxConfig?: NaxConfig,
    retrySkipChecks?: Set<string>,
    featureName?: string,
    resolverSession?: import("./dialogue").ReviewerSession,
    priorFailures?: Array<{ stage: string; modelTier: string }>,
    featureContextMarkdown?: string,
    contextBundles?: { semantic?: ContextBundle; adversarial?: ContextBundle },
    projectDir?: string,
    env?: Record<string, string | undefined>,
    naxIgnoreIndex?: NaxIgnoreIndex,
    runtime?: import("../runtime").NaxRuntime,
    priorAdversarialFindings?: {
      round: number;
      findings: Array<{ severity: string; category?: string; file: string; line?: number; issue: string }>;
    },
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
        agentManager,
        naxConfig,
        retrySkipChecks,
        featureName,
        resolverSession,
        priorFailures,
        featureContextMarkdown,
        contextBundles,
        projectDir,
        env,
        naxIgnoreIndex,
        runtime,
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
        agentManager,
        naxConfig,
        retrySkipChecks,
        featureName,
        resolverSession,
        priorFailures,
        featureContextMarkdown,
        contextBundles,
        projectDir,
        env,
        naxIgnoreIndex,
        runtime,
      );

      // Step 2: Run LLM checks regardless of mechanical result (fail-fast within LLM).
      // #136: Filter out checks that already passed in a previous review pass — retrySkipChecks
      // must be honoured here in the parallel path, not just in runReview (sequential path).
      const activeLlmCheckNames = llmCheckNames.filter((c) => !retrySkipChecks?.has(c));

      const llmStart = Date.now();
      let llmCheckResults: ReviewCheckResult[];

      if (activeLlmCheckNames.length === 0) {
        // All LLM checks already passed — skip Step 2 entirely.
        logger?.debug("review", "Skipping LLM checks (all already passed in previous review pass)", { storyId });
        llmCheckResults = [];
      } else if (
        canParallelize &&
        activeLlmCheckNames.includes("semantic") &&
        activeLlmCheckNames.includes("adversarial")
      ) {
        // semantic + adversarial concurrently (both active)
        const semanticStory: SemanticStory = {
          id: storyId ?? "",
          title: story?.title ?? "",
          description: story?.description ?? "",
          acceptanceCriteria: story?.acceptanceCriteria ?? [],
        };
        const semanticCfg = reviewConfig.semantic ?? {
          modelTier: "balanced" as const,
          diffMode: "ref" as const,
          resetRefOnRerun: false,
          rules: [] as string[],
          timeoutMs: 600_000,
          // excludePatterns omitted — runSemanticReview derives via resolveReviewExcludePatterns (ADR-009)
        };
        // advConfig is guaranteed non-null here: canParallelize required advConfig?.parallel === true
        const adversarialCfg: AdversarialReviewConfig = advConfig as AdversarialReviewConfig;

        logger?.debug("review", "Running semantic + adversarial in parallel", { storyId });
        const [semResult, advResult] = await Promise.all([
          _orchestratorDeps.runSemanticReview(
            workdir,
            storyGitRef,
            semanticStory,
            semanticCfg,
            agentManager,
            naxConfig,
            featureName,
            resolverSession,
            priorFailures,
            reviewConfig.blockingThreshold,
            featureContextMarkdown,
            contextBundles?.semantic,
            projectDir,
            naxIgnoreIndex,
            runtime,
          ),
          _orchestratorDeps.runAdversarialReview(
            workdir,
            storyGitRef,
            semanticStory,
            adversarialCfg,
            agentManager,
            naxConfig,
            featureName,
            priorFailures,
            reviewConfig.blockingThreshold,
            featureContextMarkdown,
            contextBundles?.adversarial,
            projectDir,
            naxIgnoreIndex,
            runtime,
            priorAdversarialFindings,
          ),
        ]);
        llmCheckResults = [semResult, advResult];
      } else {
        // Sequential LLM run via runReview — one or both reviewers active, or parallel disabled.
        // retrySkipChecks is passed through so runner.ts skips already-passed checks.
        const llmConfig = { ...reviewConfig, checks: activeLlmCheckNames };
        const llmResult = await runReview(
          llmConfig,
          workdir,
          executionConfig,
          qualityCommands,
          storyId,
          storyGitRef,
          story,
          agentManager,
          naxConfig,
          retrySkipChecks,
          featureName,
          resolverSession,
          priorFailures,
          featureContextMarkdown,
          contextBundles,
          undefined,
          env,
          naxIgnoreIndex,
          runtime,
          priorAdversarialFindings,
        );
        llmCheckResults = llmResult.checks;
      }

      const allChecks = [...mechanicalResult.checks, ...llmCheckResults];
      const mechanicalPassed = mechanicalResult.success;
      const llmPassed = llmCheckResults.every((c) => c.success);
      const failureReason = buildFailureReason(allChecks);

      // Build per-reviewer finding summary from LLM check results
      const reviewSummary = buildReviewSummary(llmCheckResults);

      builtIn = {
        success: mechanicalPassed && llmPassed,
        checks: allChecks,
        totalDurationMs: mechanicalResult.totalDurationMs + (Date.now() - llmStart),
        failureReason,
        reviewSummary: reviewSummary && Object.keys(reviewSummary).length > 0 ? reviewSummary : undefined,
      };

      // Write unified verdict file (fire-and-forget) when LLM checks ran
      if (llmCheckResults.length > 0 && storyId) {
        const threshold = reviewConfig.blockingThreshold ?? "error";
        const verdictReviewers: Record<string, { blocking: number; advisory: number; passed: boolean }> = {};
        const semCheck = llmCheckResults.find((c) => c.check === "semantic");
        if (semCheck) {
          verdictReviewers.semantic = {
            blocking: semCheck.findings?.length ?? 0,
            advisory: semCheck.advisoryFindings?.length ?? 0,
            passed: semCheck.success,
          };
        }
        const advCheck = llmCheckResults.find((c) => c.check === "adversarial");
        if (advCheck) {
          verdictReviewers.adversarial = {
            blocking: advCheck.findings?.length ?? 0,
            advisory: advCheck.advisoryFindings?.length ?? 0,
            passed: advCheck.success,
          };
        }
        void writeReviewVerdict({
          storyId,
          featureName,
          timestamp: new Date().toISOString(),
          blockingThreshold: threshold,
          reviewers: verdictReviewers,
        });
      }

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
        const repoRoot = projectDir ?? workdir;
        const packageDir = scopePrefix ? join(repoRoot, scopePrefix) : undefined;
        const ignoreMatchers =
          naxIgnoreIndex?.getMatchers(packageDir) ?? (await resolveNaxIgnorePatterns(repoRoot, packageDir));
        const visibleChangedFiles = filterNaxInternalPaths(changedFiles, ignoreMatchers);
        const scopedFiles = scopePrefix
          ? visibleChangedFiles.filter((f) => f === scopePrefix || f.startsWith(`${scopePrefix}/`))
          : visibleChangedFiles;
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
  async reviewFromContext(ctx: PipelineContext): Promise<OrchestratorReviewResult> {
    // #136: Consume retrySkipChecks once — cleared so subsequent retries re-evaluate
    const retrySkipChecks = ctx.retrySkipChecks;
    ctx.retrySkipChecks = undefined;

    const agentManager = ctx.agentManager;

    // When debate+dialogue are both enabled, pass the existing ReviewerSession as the resolver
    // session so runSemanticReview() can thread it through to the DebateSession.
    const reviewDebateEnabled = ctx.rootConfig?.debate?.enabled && ctx.rootConfig?.debate?.stages?.review?.enabled;
    const resolverSession = reviewDebateEnabled ? ctx.reviewerSession : undefined;

    // Assemble stage-specific v2 bundles for semantic and adversarial review in parallel.
    // Each stage uses its own provider/budget/role config from STAGE_CONTEXT_MAP so they
    // can diverge independently. Reviewers skip filterContextByRole when a bundle is set.
    const [semanticBundle, adversarialBundle] = await Promise.all([
      assembleForStage(ctx, "review-semantic"),
      assembleForStage(ctx, "review-adversarial"),
    ]);
    const contextBundles =
      semanticBundle || adversarialBundle
        ? { semantic: semanticBundle ?? undefined, adversarial: adversarialBundle ?? undefined }
        : undefined;

    const result = await this.review(
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
      agentManager,
      ctx.config,
      retrySkipChecks,
      ctx.prd.feature,
      resolverSession,
      ctx.story.priorFailures,
      ctx.featureContextMarkdown,
      contextBundles,
      ctx.projectDir,
      ctx.worktreeDependencyContext?.env,
      ctx.naxIgnoreIndex,
      ctx.runtime,
      ctx.priorAdversarialFindings,
    );

    // Update ctx.priorAdversarialFindings for the next review round (issue #736).
    // When adversarial fails with blocking findings, cache them so the next round's
    // prompt carries them forward. When adversarial passes, clear the cache.
    const advCheck = result.builtIn.checks?.find((c) => c.check === "adversarial");
    if (advCheck) {
      if (!advCheck.success && (advCheck.findings?.length ?? 0) > 0) {
        ctx.priorAdversarialFindings = {
          round: (ctx.priorAdversarialFindings?.round ?? 0) + 1,
          findings: (advCheck.findings ?? []).map((f) => ({
            severity: f.severity,
            category: f.category,
            file: f.file,
            line: f.line,
            issue: f.message,
          })),
        };
      } else if (advCheck.success) {
        ctx.priorAdversarialFindings = undefined;
      }
    }

    return result;
  }
}

export const reviewOrchestrator = new ReviewOrchestrator();
