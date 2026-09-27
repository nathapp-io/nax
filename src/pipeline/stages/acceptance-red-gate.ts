/**
 * Acceptance RED gate (US-005)
 *
 * Distinguishes a genuine RED — a non-zero exit carrying an AC-tagged failure —
 * from a test-file load crash, and issues at most one repair turn for a
 * *repairable* crash before counting the entry RED.
 *
 * Extracted from `acceptance-setup.ts` so that file stays under its line limit.
 */

import { buildAcceptanceRunCommand } from "@/acceptance";
import type { NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { acceptanceRepairOp } from "@/operations";
import { MAX_RAW_TAIL_CHARS } from "@/quality";
import { classifyAcceptanceCrash, parseTestFailuresDetailed } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
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

/** A run that exits non-zero with no AC-tagged failure — either expected RED or repairable. */
function isCrash(output: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  return parseTestFailuresDetailed(output).taggedFailureCount === 0;
}

/**
 * Classify one crashed entry and, when it is repairable, attempt a single
 * repair turn plus a re-run. The crash counts RED regardless (a load failure
 * surfacing only post-run as `AC-ERROR` is optimistically treated as RED, as
 * before this change) — the repair exists so the *post-run* acceptance stage
 * gets a file that actually loads.
 */
async function handleCrash(
  ctx: PipelineContext,
  entry: AcceptanceRedGateEntry,
  output: string,
  runCmd: string[],
  deps: AcceptanceRedGateDeps,
): Promise<void> {
  const { testPath, packageDir, language, storyId, config } = entry;
  const logger = getSafeLogger();

  const crashClass = classifyAcceptanceCrash(output, language);
  if (crashClass === "expected-red") {
    logger?.info("acceptance-setup", "RED gate: compile errors are all missing-symbol — expected RED", {
      storyId,
      testPath,
      language,
    });
    return;
  }

  logger?.warn("acceptance-setup", "RED gate: acceptance file crashed on load — issuing one repair turn", {
    storyId,
    testPath,
    language,
  });

  try {
    const repair = (await deps.callOp(
      ctx,
      packageDir,
      acceptanceRepairOp,
      { targetTestFilePath: testPath, outputTail: output.slice(-MAX_RAW_TAIL_CHARS) },
      storyId,
      config,
    )) as { testCode: string | null } | null;

    // A repair returning `testCode: null` leaves the file untouched but still re-runs it.
    if (repair?.testCode != null) {
      await deps.writeFile(testPath, repair.testCode);
    }

    await deps.autoCommitIfDirty(
      ctx.workdir,
      "acceptance-setup",
      "pre-run",
      ctx.prd.feature ?? "feature",
      undefined,
      ctx.runtime.dryRun,
    );

    const second = await deps.runTest(testPath, packageDir, runCmd, config.acceptance.timeoutMs);
    if (isCrash(second.output, second.exitCode)) {
      logger?.warn("acceptance-setup", "RED gate: acceptance file still crashes after repair", {
        storyId,
        testPath,
      });
    }
  } catch (err) {
    // Repair dispatch rejected — skip the re-run; the crash still counts RED.
    logger?.warn("acceptance-setup", "RED gate: acceptance repair failed", {
      storyId,
      testPath,
      error: errorMessage(err),
    });
  }
}

/**
 * Run the pre-implementation RED gate over each acceptance entry.
 *
 * @returns the number of entries that were RED (non-zero exit).
 */
export async function runAcceptanceRedGate(
  ctx: PipelineContext,
  entries: readonly AcceptanceRedGateEntry[],
  deps: AcceptanceRedGateDeps,
): Promise<number> {
  const logger = getSafeLogger();
  let redFailCount = 0;

  for (const entry of entries) {
    const { testPath, packageDir, testFramework, commandOverride, config } = entry;
    const runCmd = buildAcceptanceRunCommand(testPath, testFramework, commandOverride, packageDir);
    logger?.info("acceptance-setup", "Running acceptance RED gate command", {
      storyId: entry.storyId,
      cmd: runCmd.join(" "),
      packageDir,
    });

    const first = await deps.runTest(testPath, packageDir, runCmd, config.acceptance.timeoutMs);
    if (first.exitCode === 0) continue;

    if (isCrash(first.output, first.exitCode)) {
      await handleCrash(ctx, entry, first.output, runCmd, deps);
    }
    redFailCount++;
  }

  return redFailCount;
}
