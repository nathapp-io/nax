/**
 * Acceptance Fix Executor
 *
 * Executes source code fixes for acceptance test failures.
 * Runs a full agent session with sessionRole 'source-fix'.
 */

import { resolveDefaultAgent } from "../agents";
import { computeAcpHandle } from "../agents/acp/adapter";
import type { AgentAdapter, AgentRunOptions } from "../agents/types";
import type { NaxConfig } from "../config";
import { resolveConfiguredModel } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import type { DiagnosisResult } from "./types";

export interface ExecuteSourceFixOptions {
  testOutput: string;
  testFileContent?: string;
  diagnosis: DiagnosisResult;
  config: NaxConfig;
  workdir: string;
  featureName?: string;
  storyId?: string;
  acceptanceTestPath: string;
}

export interface ExecuteSourceFixResult {
  success: boolean;
  cost: number;
}

export async function executeSourceFix(
  agent: AgentAdapter,
  options: ExecuteSourceFixOptions,
): Promise<ExecuteSourceFixResult> {
  if (!agent) {
    throw new Error("[fix-executor] agent is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const resolvedModel = resolveConfiguredModel(
    config.models,
    resolveDefaultAgent(config),
    config.acceptance.fix.fixModel,
    resolveDefaultAgent(config),
  );

  const sessionName = computeAcpHandle(workdir, featureName, storyId, "source-fix");

  const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
    testOutput: options.testOutput,
    diagnosisReasoning: options.diagnosis.reasoning,
    acceptanceTestPath: options.acceptanceTestPath,
    testFileContent: options.testFileContent,
  });

  const timeoutSeconds = config.execution?.sessionTimeoutSeconds ?? 3600;

  const runOptions: AgentRunOptions = {
    prompt,
    workdir,
    modelTier: resolvedModel.modelTier ?? "balanced",
    modelDef: resolvedModel.modelDef,
    timeoutSeconds,
    sessionRole: "source-fix",
    acpSessionName: sessionName,
    featureName,
    storyId,
    config,
    pipelineStage: "acceptance",
  };

  const result = await agent.run(runOptions);

  return {
    success: result.success,
    cost: result.estimatedCost,
  };
}

// ─── Test fix (surgical) ────────────────────────────────────────────────────

export interface ExecuteTestFixOptions {
  testOutput: string;
  testFileContent: string;
  failedACs: string[];
  diagnosis: DiagnosisResult;
  config: NaxConfig;
  workdir: string;
  featureName?: string;
  storyId?: string;
  acceptanceTestPath: string;
  /** Accumulated context from prior failed fix attempts */
  previousFailure?: string;
}

export interface ExecuteTestFixResult {
  success: boolean;
  cost: number;
}

export async function executeTestFix(
  agent: AgentAdapter,
  options: ExecuteTestFixOptions,
): Promise<ExecuteTestFixResult> {
  if (!agent) {
    throw new Error("[fix-executor] agent is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const resolvedModel = resolveConfiguredModel(
    config.models,
    resolveDefaultAgent(config),
    config.acceptance.fix.fixModel,
    resolveDefaultAgent(config),
  );

  const sessionName = computeAcpHandle(workdir, featureName, storyId, "test-fix");

  const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
    testOutput: options.testOutput,
    diagnosisReasoning: options.diagnosis.reasoning,
    failedACs: options.failedACs,
    previousFailure: options.previousFailure,
    acceptanceTestPath: options.acceptanceTestPath,
    testFileContent: options.testFileContent,
  });

  const timeoutSeconds = config.execution?.sessionTimeoutSeconds ?? 3600;

  const runOptions: AgentRunOptions = {
    prompt,
    workdir,
    modelTier: resolvedModel.modelTier ?? "balanced",
    modelDef: resolvedModel.modelDef,
    timeoutSeconds,
    sessionRole: "test-fix",
    acpSessionName: sessionName,
    featureName,
    storyId,
    config,
    pipelineStage: "acceptance",
  };

  const result = await agent.run(runOptions);

  return {
    success: result.success,
    cost: result.estimatedCost,
  };
}
