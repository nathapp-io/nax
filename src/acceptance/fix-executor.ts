/**
 * Acceptance Fix Executor
 *
 * Executes source code fixes for acceptance test failures.
 * Runs a full agent session with sessionRole 'source-fix'.
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config/schema";
import type { DiagnosisResult } from "./types";

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

export async function executeSourceFix(
  agent: AgentAdapter,
  options: ExecuteSourceFixOptions,
): Promise<ExecuteSourceFixResult> {
  throw new Error("Not implemented");
}
