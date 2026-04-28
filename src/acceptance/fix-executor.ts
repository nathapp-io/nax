/**
 * Acceptance Fix Executor
 *
 * Executes source code fixes for acceptance test failures.
 * Runs a full agent session with sessionRole 'source-fix'.
 */

import type { IAgentManager } from "../agents";
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
  agentManager: IAgentManager,
  options: ExecuteSourceFixOptions,
): Promise<ExecuteSourceFixResult> {
  if (!agentManager) {
    throw new Error("[fix-executor] agentManager is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const resolvedModel = resolveConfiguredModel(
    config.models,
    agentManager.getDefault(),
    config.acceptance.fix.fixModel,
    agentManager.getDefault(),
  );

  const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
    testOutput: options.testOutput,
    diagnosisReasoning: options.diagnosis.reasoning,
    acceptanceTestPath: options.acceptanceTestPath,
    testFileContent: options.testFileContent,
  });

  const timeoutSeconds = Math.ceil((config.acceptance?.timeoutMs ?? 1_800_000) / 1000);

  const result = await agentManager.run({
    runOptions: {
      prompt,
      workdir,
      modelTier: resolvedModel.modelTier ?? "balanced",
      modelDef: resolvedModel.modelDef,
      timeoutSeconds,
      sessionRole: "source-fix",
      featureName,
      storyId,
      config,
      pipelineStage: "acceptance",
    },
  });

  return {
    success: result.success,
    cost: result.estimatedCostUsd,
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
  agentManager: IAgentManager,
  options: ExecuteTestFixOptions,
): Promise<ExecuteTestFixResult> {
  if (!agentManager) {
    throw new Error("[fix-executor] agentManager is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const resolvedModel = resolveConfiguredModel(
    config.models,
    agentManager.getDefault(),
    config.acceptance.fix.fixModel,
    agentManager.getDefault(),
  );

  const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
    testOutput: options.testOutput,
    diagnosisReasoning: options.diagnosis.reasoning,
    failedACs: options.failedACs,
    previousFailure: options.previousFailure,
    acceptanceTestPath: options.acceptanceTestPath,
    testFileContent: options.testFileContent,
  });

  const timeoutSeconds = Math.ceil((config.acceptance?.timeoutMs ?? 1_800_000) / 1000);

  const result = await agentManager.run({
    runOptions: {
      prompt,
      workdir,
      modelTier: resolvedModel.modelTier ?? "balanced",
      modelDef: resolvedModel.modelDef,
      timeoutSeconds,
      sessionRole: "test-fix",
      featureName,
      storyId,
      config,
      pipelineStage: "acceptance",
    },
  });

  return {
    success: result.success,
    cost: result.estimatedCostUsd,
  };
}
