/**
 * The pre-run pipeline: acceptance test setup with its RED gate.
 *
 * Extracted from unified-executor so the executor does not carry the context
 * construction, and so the failure path has somewhere to live. That failure
 * path is the reason this file exists: a throw inside acceptance setup used to
 * be caught by runPipeline, returned as a fail result, and then discarded by
 * the caller — leaving a run that had installed no acceptance gate and said
 * nothing about it.
 */

import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd/types";
// Leaf imports, not the "@/pipeline" barrel: the barrel reaches back into
// src/execution and would put this module inside a runtime import cycle.
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import type { PipelineContext, PipelineStage } from "../pipeline/types";

export interface PreRunDeps {
  readonly config: PipelineContext["config"];
  readonly workdir: string;
  readonly featureDir: PipelineContext["featureDir"];
  readonly hooks: PipelineContext["hooks"];
  readonly agentGetFn: PipelineContext["agentGetFn"];
  readonly agentManager: PipelineContext["agentManager"];
  readonly sessionManager: PipelineContext["sessionManager"];
  readonly runtime: PipelineContext["runtime"];
  readonly abortSignal: PipelineContext["abortSignal"];
  readonly eventEmitter?: PipelineEventEmitter;
}

/**
 * Runs acceptance setup and returns the context it produced, so the caller can
 * read `acceptanceTestPaths` from it later.
 *
 * A failure is logged, not thrown: continuing is long-standing behaviour and a
 * hard abort here would change it. What must never happen again is continuing
 * *silently*.
 */
export async function runPreRunPipeline(
  deps: PreRunDeps,
  prd: PRD,
  naxIgnoreIndex: PipelineContext["naxIgnoreIndex"],
  /** Injected by the caller: importing the stages barrel here would put this
   *  module inside a runtime import cycle back through unified-executor. */
  stages: PipelineStage[],
): Promise<PipelineContext> {
  const preRunCtx: PipelineContext = {
    config: deps.config,
    rootConfig: deps.config,
    prd,
    projectDir: deps.workdir,
    workdir: deps.workdir,
    naxIgnoreIndex,
    featureDir: deps.featureDir,
    story: prd.userStories[0],
    stories: prd.userStories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    hooks: deps.hooks,
    agentGetFn: deps.agentGetFn,
    agentManager: deps.agentManager,
    sessionManager: deps.sessionManager,
    runtime: deps.runtime,
    abortSignal: deps.abortSignal,
  };

  const result = await runPipeline(stages, preRunCtx, deps.eventEmitter);
  if (!result.success) {
    getSafeLogger()?.error("execution", "Pre-run pipeline (acceptance test setup) failed — continuing without it", {
      stoppedAtStage: result.stoppedAtStage,
      finalAction: result.finalAction,
      reason: result.reason,
    });
  }
  return preRunCtx;
}
