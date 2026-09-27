/**
 * Acceptance RED gate (US-005)
 *
 * Distinguishes a genuine RED — a non-zero exit carrying an AC-tagged failure —
 * from a test-file load crash, and issues at most one repair turn for a
 * *repairable* crash before counting the entry RED.
 *
 * Extracted from `acceptance-setup.ts` so that file stays under its line limit.
 */

import type { NaxConfig } from "@/config";
import type { PipelineContext } from "../types";
import type { _acceptanceSetupDeps } from "./acceptance-setup";

/** One per-package acceptance file the RED gate must run. */
export interface AcceptanceRedGateEntry {
  testPath: string;
  packageDir: string;
  testFramework?: string;
  commandOverride?: string;
  language?: string;
  storyId?: string;
  config: NaxConfig;
}

/** Injectable collaborators the gate needs (subset of the setup stage's deps). */
export type AcceptanceRedGateDeps = Pick<
  typeof _acceptanceSetupDeps,
  "runTest" | "callOp" | "writeFile" | "autoCommitIfDirty"
>;

/**
 * Run the pre-implementation RED gate over each acceptance entry.
 *
 * @returns the number of entries that were RED (non-zero exit).
 */
export async function runAcceptanceRedGate(
  _ctx: PipelineContext,
  _entries: readonly AcceptanceRedGateEntry[],
  _deps: AcceptanceRedGateDeps,
): Promise<number> {
  return 0;
}
