/**
 * Acceptance Fix Diagnosis
 *
 * Runs a full agent session to diagnose acceptance test failures.
 * Determines whether the failure is due to a source bug, test bug, or both.
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config/schema";
import type { DiagnosisResult } from "./types";

export interface DiagnoseOptions {
  testOutput: string;
  testFileContent: string;
  config: NaxConfig;
  workdir: string;
  featureName?: string;
  storyId?: string;
}

export function diagnoseAcceptanceFailure(_agent: AgentAdapter, _options: DiagnoseOptions): Promise<DiagnosisResult> {
  throw new Error("Not implemented");
}
