/**
 * Story Dispatcher — Per-Iteration Logic
 *
 * Handles the per-iteration logic extracted from runner.ts:
 * - Selecting next story/batch from precomputed plan
 * - Building routing and pipeline context
 * - Running the full pipeline
 * - Handling pipeline result switch/case (success, pause, skip, fail, escalate)
 * - PRD updates and reporter notifications
 */

import type { NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import {
	type PRD,
	type UserStory,
	getNextStory,
	markStoryFailed,
	markStoryPaused,
	markStoryPassed,
	savePRD,
} from "../prd";
import { routeTask } from "../routing";
import { routeBatch as llmRouteBatch } from "../routing/strategies/llm";
import { captureGitRef } from "../utils/git";
import type { StoryBatch } from "./batching";
import { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
import { hookCtx } from "./helpers";
import { runPostAgentVerification } from "./post-verify";
import { appendProgress } from "./progress";
import { StatusWriter } from "./status-writer";
import { getAgent } from "../agents";
import { convertFixStoryToUserStory, generateFixStories } from "../acceptance";

/**
 * Context passed to dispatchIteration containing all mutable state
 */
export interface DispatchContext {
	// Configuration
	config: NaxConfig;
	hooks: LoadedHooksConfig;
	feature: string;
	featureDir?: string;
	dryRun: boolean;
	useBatch: boolean;
	eventEmitter?: PipelineEventEmitter;

	// Paths
	prdPath: string;
	workdir: string;

	// Mutable state
	prd: PRD;
	totalCost: number;
	iterations: number;
	storiesCompleted: number;
	allStoryMetrics: StoryMetrics[];
	timeoutRetryCountMap: Map<string, number>;
	batchPlan: StoryBatch[];
	currentBatchIndex: number;
	prdDirty: boolean;

	// Tracking
	runId: string;
	startTime: number;
	startedAt: string;

	// Plugins
	pluginRegistry: PluginRegistry;

	// Status writer
	statusWriter: StatusWriter;
}

/**
 * Result from a single iteration dispatch
 */
export interface DispatchResult {
	action: "continue" | "complete" | "pause" | "stalled";
	reason?: string;
	updatedContext: DispatchContext;
}

/**
 * Apply cached routing overrides from story.routing to a fresh routing decision.
 */
function applyCachedRouting(
	routing: ReturnType<typeof routeTask>,
	story: UserStory,
	config: NaxConfig,
): ReturnType<typeof routeTask> {
	if (!story.routing) return routing;
	const overrides: Partial<ReturnType<typeof routeTask>> = {};
	if (story.routing.complexity) {
		overrides.complexity = story.routing.complexity;
		overrides.modelTier = (config.autoMode.complexityRouting[story.routing.complexity] ?? "balanced") as any;
	}
	if (story.routing.testStrategy) {
		overrides.testStrategy = story.routing.testStrategy;
	}
	return { ...routing, ...overrides };
}

/**
 * Try LLM batch routing for ready stories. Logs and swallows errors (falls back to per-story routing).
 */
async function tryLlmBatchRoute(config: NaxConfig, stories: UserStory[], label = "routing"): Promise<void> {
	const mode = config.routing.llm?.mode ?? "hybrid";
	if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;
	const logger = getSafeLogger();
	try {
		logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
		await llmRouteBatch(stories, { config });
		logger?.debug("routing", "LLM batch routing complete", { label });
	} catch (err) {
		logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
			error: (err as Error).message,
			label,
		});
	}
}

/**
 * Determine the outcome when max attempts are reached for an escalation.
 *
 * Returns 'pause' if the failure category requires human review
 * (isolation-violation or verifier-rejected). For all other categories
 * (session-failure, tests-failing, or no category) returns 'fail'.
 *
 * Exported for unit-testing without running the full runner loop.
 */
export function resolveMaxAttemptsOutcome(
	failureCategory?: "isolation-violation" | "verifier-rejected" | "session-failure" | "tests-failing",
): "pause" | "fail" {
	if (!failureCategory) {
		return "fail";
	}

	switch (failureCategory) {
		case "isolation-violation":
		case "verifier-rejected":
			return "pause";
		case "session-failure":
		case "tests-failing":
			return "fail";
		default:
			// Exhaustive check: if a new FailureCategory is added, this will error
			failureCategory satisfies never;
			return "fail";
	}
}

/**
 * Dispatch a single iteration: select story/batch, run pipeline, handle result
 */
export async function dispatchIteration(ctx: DispatchContext): Promise<DispatchResult> {
	const logger = getSafeLogger();

	// Select next story/batch
	let storiesToExecute: UserStory[];
	let isBatchExecution: boolean;
	let story: UserStory;
	let routing: ReturnType<typeof routeTask>;

	if (ctx.useBatch && ctx.currentBatchIndex < ctx.batchPlan.length) {
		// Get next batch from precomputed plan
		const batch = ctx.batchPlan[ctx.currentBatchIndex];
		ctx.currentBatchIndex++;

		// Filter out already-completed stories
		storiesToExecute = batch.stories.filter(
			(s) => !s.passes && s.status !== "skipped" && s.status !== "blocked" && s.status !== "failed" && s.status !== "paused",
		);
		isBatchExecution = batch.isBatch && storiesToExecute.length > 1;

		if (storiesToExecute.length === 0) {
			// All stories in this batch already completed, move to next batch
			return { action: "continue", updatedContext: ctx };
		}

		// Use first story as the primary story for routing/context
		story = storiesToExecute[0];
		routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
		routing = applyCachedRouting(routing, story, ctx.config);
	} else {
		// Fallback to single-story mode
		const nextStory = getNextStory(ctx.prd);
		if (!nextStory) {
			logger?.warn("execution", "No actionable stories (check dependencies)");
			return { action: "complete", updatedContext: ctx };
		}

		story = nextStory;
		storiesToExecute = [story];
		isBatchExecution = false;

		routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
		routing = applyCachedRouting(routing, story, ctx.config);
	}

	// Pre-iteration tier escalation check (BUG-16 + BUG-17)
	const currentTier = story.routing?.modelTier ?? routing.modelTier;
	const tierOrder = ctx.config.autoMode.escalation?.tierOrder || [];
	const tierCfg = tierOrder.length > 0 ? getTierConfig(currentTier, tierOrder) : undefined;

	if (tierCfg && (story.attempts ?? 0) >= tierCfg.attempts) {
		// Exceeded current tier budget — try to escalate
		const nextTier = escalateTier(currentTier, tierOrder);

		if (nextTier && ctx.config.autoMode.escalation.enabled) {
			logger?.warn("escalation", "Story exceeded tier budget, escalating", {
				storyId: story.id,
				attempts: story.attempts,
				tierAttempts: tierCfg.attempts,
				currentTier,
				nextTier,
			});

			// Update story routing in PRD and reset attempts for new tier
			ctx.prd.userStories = ctx.prd.userStories.map((s) =>
				s.id === story.id
					? {
							...s,
							attempts: 0,
							routing: s.routing ? { ...s.routing, modelTier: nextTier } : { ...routing, modelTier: nextTier },
						}
					: s,
			);
			await savePRD(ctx.prd, ctx.prdPath);
			ctx.prdDirty = true;

			// Hybrid mode: re-route story after escalation
			const routingMode = ctx.config.routing.llm?.mode ?? "hybrid";
			if (routingMode === "hybrid") {
				await tryLlmBatchRoute(ctx.config, [story], "hybrid-re-route");
			}

			return { action: "continue", updatedContext: ctx };
		}

		// No next tier or escalation disabled — mark story as failed
		logger?.error("execution", "Story failed - all tiers exhausted", {
			storyId: story.id,
			attempts: story.attempts,
		});
		markStoryFailed(ctx.prd, story.id);
		await savePRD(ctx.prd, ctx.prdPath);
		ctx.prdDirty = true;

		if (ctx.featureDir) {
			await appendProgress(ctx.featureDir, story.id, "failed", `${story.title} — All tiers exhausted`);
		}

		await fireHook(
			ctx.hooks,
			"on-story-fail",
			hookCtx(ctx.feature, {
				storyId: story.id,
				status: "failed",
				reason: `All tiers exhausted (${story.attempts} attempts)`,
				cost: ctx.totalCost,
			}),
			ctx.workdir,
		);

		return { action: "continue", updatedContext: ctx };
	}

	// Check cost limit
	if (ctx.totalCost >= ctx.config.execution.costLimit) {
		logger?.warn("execution", "Cost limit reached, pausing", {
			totalCost: ctx.totalCost,
			costLimit: ctx.config.execution.costLimit,
		});
		await fireHook(
			ctx.hooks,
			"on-pause",
			hookCtx(ctx.feature, {
				storyId: story.id,
				reason: `Cost limit reached: $${ctx.totalCost.toFixed(2)}`,
				cost: ctx.totalCost,
			}),
			ctx.workdir,
		);
		return { action: "pause", reason: "Cost limit reached", updatedContext: ctx };
	}

	logger?.info("execution", `Starting iteration ${ctx.iterations}`, {
		iteration: ctx.iterations,
		isBatch: isBatchExecution,
		batchSize: isBatchExecution ? storiesToExecute.length : 1,
		storyId: story.id,
		storyTitle: story.title,
		...(isBatchExecution && { batchStoryIds: storiesToExecute.map((s) => s.id) }),
	});

	logger?.info("iteration.start", `Starting iteration ${ctx.iterations}`, {
		iteration: ctx.iterations,
		storyId: story.id,
		storyTitle: story.title,
		isBatch: isBatchExecution,
		batchSize: isBatchExecution ? storiesToExecute.length : 1,
		modelTier: routing.modelTier,
		complexity: routing.complexity,
	});

	// Fire story-start hook
	await fireHook(
		ctx.hooks,
		"on-story-start",
		hookCtx(ctx.feature, {
			storyId: story.id,
			model: routing.modelTier,
			agent: ctx.config.autoMode.defaultAgent,
			iteration: ctx.iterations,
		}),
		ctx.workdir,
	);

	if (ctx.dryRun) {
		// Dry-run: mark as passed and continue
		ctx.statusWriter.setPrd(ctx.prd);
		ctx.statusWriter.setCurrentStory({
			storyId: story.id,
			title: story.title,
			complexity: routing.complexity,
			tddStrategy: routing.testStrategy,
			model: routing.modelTier,
			attempt: (story.attempts ?? 0) + 1,
			phase: "routing",
		});
		await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

		for (const s of storiesToExecute) {
			logger?.info("execution", "[DRY RUN] Would execute agent here", {
				storyId: s.id,
				storyTitle: s.title,
				modelTier: routing.modelTier,
				complexity: routing.complexity,
				testStrategy: routing.testStrategy,
			});
		}

		for (const s of storiesToExecute) {
			markStoryPassed(ctx.prd, s.id);
		}
		ctx.storiesCompleted += storiesToExecute.length;
		ctx.prdDirty = true;
		await savePRD(ctx.prd, ctx.prdPath);

		ctx.statusWriter.setPrd(ctx.prd);
		ctx.statusWriter.setCurrentStory(null);
		await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

		return { action: "continue", updatedContext: ctx };
	}

	// Capture git ref for scoped verification
	const storyGitRef = await captureGitRef(ctx.workdir);

	// Build pipeline context
	const storyStartTime = new Date().toISOString();
	const pipelineContext: PipelineContext = {
		config: ctx.config,
		prd: ctx.prd,
		story,
		stories: storiesToExecute,
		routing: routing as RoutingResult,
		workdir: ctx.workdir,
		featureDir: ctx.featureDir,
		hooks: ctx.hooks,
		plugins: ctx.pluginRegistry,
		storyStartTime,
	};

	logger?.info("agent.start", "Starting agent execution", {
		storyId: story.id,
		agent: ctx.config.autoMode.defaultAgent,
		modelTier: routing.modelTier,
		testStrategy: routing.testStrategy,
		isBatch: isBatchExecution,
	});

	// Status write: before story execution
	ctx.statusWriter.setPrd(ctx.prd);
	ctx.statusWriter.setCurrentStory({
		storyId: story.id,
		title: story.title,
		complexity: routing.complexity,
		tddStrategy: routing.testStrategy,
		model: routing.modelTier,
		attempt: (story.attempts ?? 0) + 1,
		phase: "routing",
	});
	await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

	// Run pipeline
	const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);

	logger?.info("agent.complete", "Agent execution completed", {
		storyId: story.id,
		success: pipelineResult.success,
		finalAction: pipelineResult.finalAction,
		estimatedCost: pipelineResult.context.agentResult?.estimatedCost,
	});

	// Update PRD reference (pipeline may have modified it)
	ctx.prd = pipelineResult.context.prd;

	// Get reporters
	const reporters = ctx.pluginRegistry.getReporters();

	// Handle pipeline result
	if (pipelineResult.success) {
		// Pipeline completed successfully
		ctx.totalCost += pipelineResult.context.agentResult?.estimatedCost || 0;
		ctx.prdDirty = true;

		// Collect story metrics
		if (pipelineResult.context.storyMetrics) {
			ctx.allStoryMetrics.push(...pipelineResult.context.storyMetrics);
		}

		// Post-agent verification
		const verifyResult = await runPostAgentVerification({
			config: ctx.config,
			prd: ctx.prd,
			prdPath: ctx.prdPath,
			workdir: ctx.workdir,
			featureDir: ctx.featureDir,
			story,
			storiesToExecute,
			allStoryMetrics: ctx.allStoryMetrics,
			timeoutRetryCountMap: ctx.timeoutRetryCountMap,
			storyGitRef,
		});
		const verificationPassed = verifyResult.passed;
		ctx.prd = verifyResult.prd;

		if (verificationPassed) {
			ctx.storiesCompleted += storiesToExecute.length;

			// Log story completion and emit reporter events
			for (const completedStory of storiesToExecute) {
				logger?.info("story.complete", "Story completed successfully", {
					storyId: completedStory.id,
					storyTitle: completedStory.title,
					totalCost: ctx.totalCost,
					durationMs: Date.now() - ctx.startTime,
				});

				// Emit onStoryComplete to reporters
				for (const reporter of reporters) {
					if (reporter.onStoryComplete) {
						try {
							await reporter.onStoryComplete({
								runId: ctx.runId,
								storyId: completedStory.id,
								status: "completed",
								durationMs: Date.now() - ctx.startTime,
								cost: pipelineResult.context.agentResult?.estimatedCost || 0,
								tier: routing.modelTier,
								testStrategy: routing.testStrategy,
							});
						} catch (error) {
							logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
						}
					}
				}
			}
		}
	} else {
		// Pipeline stopped early — handle based on finalAction
		switch (pipelineResult.finalAction) {
			case "pause":
				markStoryPaused(ctx.prd, story.id);
				await savePRD(ctx.prd, ctx.prdPath);
				ctx.prdDirty = true;

				logger?.warn("pipeline", "Story paused", {
					storyId: story.id,
					reason: pipelineResult.reason,
				});

				await fireHook(
					ctx.hooks,
					"on-pause",
					hookCtx(ctx.feature, {
						storyId: story.id,
						reason: pipelineResult.reason || "Pipeline paused",
						cost: ctx.totalCost,
					}),
					ctx.workdir,
				);

				for (const reporter of reporters) {
					if (reporter.onStoryComplete) {
						try {
							await reporter.onStoryComplete({
								runId: ctx.runId,
								storyId: story.id,
								status: "paused",
								durationMs: Date.now() - ctx.startTime,
								cost: pipelineResult.context.agentResult?.estimatedCost || 0,
								tier: routing.modelTier,
								testStrategy: routing.testStrategy,
							});
						} catch (error) {
							logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
						}
					}
				}
				break;

			case "skip":
				logger?.warn("pipeline", "Story skipped", {
					storyId: story.id,
					reason: pipelineResult.reason,
				});
				ctx.prdDirty = true;

				for (const reporter of reporters) {
					if (reporter.onStoryComplete) {
						try {
							await reporter.onStoryComplete({
								runId: ctx.runId,
								storyId: story.id,
								status: "skipped",
								durationMs: Date.now() - ctx.startTime,
								cost: 0,
								tier: routing.modelTier,
								testStrategy: routing.testStrategy,
							});
						} catch (error) {
							logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
						}
					}
				}
				break;

			case "fail":
				markStoryFailed(ctx.prd, story.id, pipelineResult.context.tddFailureCategory);
				await savePRD(ctx.prd, ctx.prdPath);
				ctx.prdDirty = true;

				logger?.error("pipeline", "Story failed", {
					storyId: story.id,
					reason: pipelineResult.reason,
				});

				if (ctx.featureDir) {
					await appendProgress(ctx.featureDir, story.id, "failed", `${story.title} — ${pipelineResult.reason}`);
				}

				await fireHook(
					ctx.hooks,
					"on-story-fail",
					hookCtx(ctx.feature, {
						storyId: story.id,
						status: "failed",
						reason: pipelineResult.reason || "Pipeline failed",
						cost: ctx.totalCost,
					}),
					ctx.workdir,
				);

				for (const reporter of reporters) {
					if (reporter.onStoryComplete) {
						try {
							await reporter.onStoryComplete({
								runId: ctx.runId,
								storyId: story.id,
								status: "failed",
								durationMs: Date.now() - ctx.startTime,
								cost: pipelineResult.context.agentResult?.estimatedCost || 0,
								tier: routing.modelTier,
								testStrategy: routing.testStrategy,
							});
						} catch (error) {
							logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
						}
					}
				}
				break;

			case "escalate": {
				const nextTier = escalateTier(routing.modelTier, ctx.config.autoMode.escalation.tierOrder);
				const escalateWholeBatch = ctx.config.autoMode.escalation.escalateEntireBatch ?? true;
				const storiesToEscalate = isBatchExecution && escalateWholeBatch ? storiesToExecute : [story];

				const escalateRetryAsLite = pipelineResult.context.retryAsLite === true;
				const escalateFailureCategory = pipelineResult.context.tddFailureCategory;

				if (nextTier && ctx.config.autoMode.escalation.enabled) {
					const maxAttempts = calculateMaxIterations(ctx.config.autoMode.escalation.tierOrder);
					const canEscalate = storiesToEscalate.every((s) => (s.attempts ?? 0) < maxAttempts);

					if (canEscalate) {
						for (const s of storiesToEscalate) {
							logger?.warn("escalation", "Escalating story to next tier", {
								storyId: s.id,
								nextTier,
								retryAsLite: escalateRetryAsLite,
							});
						}

						const errorMessage = `Attempt ${story.attempts + 1} failed with model tier: ${routing.modelTier}${isBatchExecution ? " (in batch)" : ""}`;

						ctx.prd.userStories = ctx.prd.userStories.map((s) => {
							const shouldEscalate = storiesToEscalate.some((story) => story.id === s.id);
							if (!shouldEscalate) return s;

							const updatedRouting = s.routing
								? {
										...s.routing,
										modelTier: nextTier,
										...(escalateRetryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
									}
								: undefined;

							return {
								...s,
								attempts: (s.attempts ?? 0) + 1,
								routing: updatedRouting,
								priorErrors: [...(s.priorErrors || []), errorMessage],
							};
						});
						await savePRD(ctx.prd, ctx.prdPath);
						ctx.prdDirty = true;

						// Hybrid mode: re-route escalated stories
						const routingMode = ctx.config.routing.llm?.mode ?? "hybrid";
						if (routingMode === "hybrid") {
							await tryLlmBatchRoute(ctx.config, storiesToEscalate, "hybrid-re-route-pipeline");
						}
					} else {
						// Max attempts reached
						const maxAttemptsOutcome = resolveMaxAttemptsOutcome(escalateFailureCategory);

						if (maxAttemptsOutcome === "pause") {
							markStoryPaused(ctx.prd, story.id);
							await savePRD(ctx.prd, ctx.prdPath);
							ctx.prdDirty = true;

							logger?.warn("execution", "Story paused - max attempts reached (needs human review)", {
								storyId: story.id,
								failureCategory: escalateFailureCategory,
							});

							if (ctx.featureDir) {
								await appendProgress(ctx.featureDir, story.id, "paused", `${story.title} — Max attempts reached (needs human review)`);
							}

							await fireHook(
								ctx.hooks,
								"on-pause",
								hookCtx(ctx.feature, {
									storyId: story.id,
									reason: `Max attempts reached (${escalateFailureCategory ?? "unknown"} requires human review)`,
									cost: ctx.totalCost,
								}),
								ctx.workdir,
							);
						} else {
							markStoryFailed(ctx.prd, story.id, escalateFailureCategory);
							await savePRD(ctx.prd, ctx.prdPath);
							ctx.prdDirty = true;

							logger?.error("execution", "Story failed - max attempts reached", {
								storyId: story.id,
								failureCategory: escalateFailureCategory,
							});

							if (ctx.featureDir) {
								await appendProgress(ctx.featureDir, story.id, "failed", `${story.title} — Max attempts reached`);
							}

							await fireHook(
								ctx.hooks,
								"on-story-fail",
								hookCtx(ctx.feature, {
									storyId: story.id,
									status: "failed",
									reason: "Max attempts reached",
									cost: ctx.totalCost,
								}),
								ctx.workdir,
							);
						}
					}
				} else {
					// No next tier or escalation disabled
					const noTierOutcome = resolveMaxAttemptsOutcome(escalateFailureCategory);

					if (noTierOutcome === "pause") {
						markStoryPaused(ctx.prd, story.id);
						await savePRD(ctx.prd, ctx.prdPath);
						ctx.prdDirty = true;

						logger?.warn("execution", "Story paused - no tier available (needs human review)", {
							storyId: story.id,
							failureCategory: escalateFailureCategory,
						});

						if (ctx.featureDir) {
							await appendProgress(ctx.featureDir, story.id, "paused", `${story.title} — Execution stopped (needs human review)`);
						}

						await fireHook(
							ctx.hooks,
							"on-pause",
							hookCtx(ctx.feature, {
								storyId: story.id,
								reason: `Execution stopped (${escalateFailureCategory ?? "unknown"} requires human review)`,
								cost: ctx.totalCost,
							}),
							ctx.workdir,
						);
					} else {
						markStoryFailed(ctx.prd, story.id, escalateFailureCategory);
						await savePRD(ctx.prd, ctx.prdPath);
						ctx.prdDirty = true;

						logger?.error("execution", "Story failed - execution failed", {
							storyId: story.id,
						});

						if (ctx.featureDir) {
							await appendProgress(ctx.featureDir, story.id, "failed", `${story.title} — Execution failed`);
						}

						await fireHook(
							ctx.hooks,
							"on-story-fail",
							hookCtx(ctx.feature, {
								storyId: story.id,
								status: "failed",
								reason: "Execution failed",
								cost: ctx.totalCost,
							}),
							ctx.workdir,
						);
					}
				}
				break;
			}
		}
	}

	return { action: "continue", updatedContext: ctx };
}
