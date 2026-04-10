/**
 * Acceptance Fix Executor
 *
 * Executes source code fixes for acceptance test failures.
 * Runs a full agent session with sessionRole 'source-fix'.
 */

import { buildSessionName } from "../agents/acp/adapter";
import type { AgentAdapter, AgentRunOptions } from "../agents/types";
import type { NaxConfig } from "../config/schema";
import type { ModelTier } from "../config/schema-types";
import { resolveModelForAgent } from "../config/schema-types";
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

export function buildSourceFixPrompt(options: ExecuteSourceFixOptions): string {
  const { testOutput, diagnosis, acceptanceTestPath, testFileContent } = options;

  let prompt = `ACCEPTANCE TEST FAILURE:\n${testOutput}\n\n`;

  if (diagnosis.reasoning) {
    prompt += `DIAGNOSIS:\n${diagnosis.reasoning}\n\n`;
  }

  prompt += `ACCEPTANCE TEST FILE: ${acceptanceTestPath}\n\n`;

  if (testFileContent && testFileContent.length > 0) {
    prompt += `\`\`\`typescript\n${testFileContent}\n\`\`\`\n\n`;
  }

  prompt += "Fix the source implementation. Do NOT modify the test file.";

  return prompt;
}

export async function executeSourceFix(
  agent: AgentAdapter,
  options: ExecuteSourceFixOptions,
): Promise<ExecuteSourceFixResult> {
  if (!agent) {
    throw new Error("[fix-executor] agent is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const modelDef = resolveModelForAgent(
    config.models,
    config.autoMode.defaultAgent,
    config.acceptance.fix.fixModel,
    config.autoMode.defaultAgent,
  );

  const sessionName = buildSessionName(workdir, featureName, storyId, "source-fix");

  const prompt = buildSourceFixPrompt(options);

  const timeoutSeconds = config.execution?.sessionTimeoutSeconds ?? 3600;

  const runOptions: AgentRunOptions = {
    prompt,
    workdir,
    modelTier: undefined as unknown as ModelTier,
    modelDef,
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

export function buildTestFixPrompt(options: ExecuteTestFixOptions): string {
  const { testOutput, diagnosis, acceptanceTestPath, testFileContent, failedACs, previousFailure } = options;

  let prompt = "ACCEPTANCE TEST BUG — surgical fix required.\n\n";
  prompt += `FAILING ACS: ${failedACs.join(", ")}\n\n`;
  prompt += `TEST OUTPUT:\n${testOutput}\n\n`;

  if (diagnosis.reasoning) {
    prompt += `DIAGNOSIS:\n${diagnosis.reasoning}\n\n`;
  }

  if (previousFailure && previousFailure.length > 0) {
    prompt += `PREVIOUS FAILED ATTEMPTS:\n${previousFailure}\n\n`;
  }

  prompt += `ACCEPTANCE TEST FILE: ${acceptanceTestPath}\n\n`;
  prompt += `\`\`\`typescript\n${testFileContent}\n\`\`\`\n\n`;
  prompt += "Fix ONLY the failing test assertions for the ACs listed above. ";
  prompt += "Do NOT modify passing tests. Do NOT modify source code. ";
  prompt += "Edit the test file in place.";

  return prompt;
}

export async function executeTestFix(
  agent: AgentAdapter,
  options: ExecuteTestFixOptions,
): Promise<ExecuteTestFixResult> {
  if (!agent) {
    throw new Error("[fix-executor] agent is required");
  }

  const { config, workdir, featureName, storyId } = options;

  const modelDef = resolveModelForAgent(
    config.models,
    config.autoMode.defaultAgent,
    config.acceptance.fix.fixModel,
    config.autoMode.defaultAgent,
  );

  const sessionName = buildSessionName(workdir, featureName, storyId, "test-fix");

  const prompt = buildTestFixPrompt(options);

  const timeoutSeconds = config.execution?.sessionTimeoutSeconds ?? 3600;

  const runOptions: AgentRunOptions = {
    prompt,
    workdir,
    modelTier: undefined as unknown as ModelTier,
    modelDef,
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
