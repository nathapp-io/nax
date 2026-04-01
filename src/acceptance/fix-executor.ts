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
import { spawn } from "../utils/bun-deps";
import type { DiagnosisResult } from "./types";

interface FixExecutorDeps {
  spawn: typeof spawn;
}

export const _fixExecutorDeps: FixExecutorDeps = { spawn };

export interface ExecuteSourceFixOptions {
  testOutput: string;
  testFileContent: string;
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

function buildSourceFixPrompt(options: ExecuteSourceFixOptions): string {
  const { testOutput, diagnosis, acceptanceTestPath } = options;

  let prompt = `ACCEPTANCE TEST FAILURE:\n${testOutput}\n\n`;

  if (diagnosis.reasoning) {
    prompt += `DIAGNOSIS:\n${diagnosis.reasoning}\n\n`;
  }

  prompt += `ACCEPTANCE TEST FILE: ${acceptanceTestPath}\n\n`;
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

  const { testOutput, testFileContent, diagnosis, config, workdir, featureName, storyId, acceptanceTestPath } = options;

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
    pipelineStage: "run",
  };

  const result = await agent.run(runOptions);

  const verifyProc = _fixExecutorDeps.spawn(["bun", "test", acceptanceTestPath], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await verifyProc.exited;

  return {
    success: exitCode === 0,
    cost: result.estimatedCost,
  };
}
