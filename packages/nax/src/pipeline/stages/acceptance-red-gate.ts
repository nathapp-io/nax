/**
 * Acceptance RED gate (US-005)
 *
 * Distinguishes a genuine RED — a non-zero exit carrying an AC-tagged failure —
 * from a test-file load crash, and issues at most two repair turns for a
 * *repairable* crash before counting the entry RED.
 *
 * Extracted from `acceptance-setup.ts` so that file stays under its line limit.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { buildAcceptanceRunCommand } from "@/acceptance";
import type { NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { acceptanceRepairOp } from "@/operations";
import { MAX_RAW_TAIL_CHARS } from "@/quality";
import { classifyAcceptanceCrash, isCommandNotRunnable, parseTestFailuresDetailed } from "@/test-runners";
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
  "runTest" | "callOp" | "readFile" | "writeFile" | "autoCommitIfDirty"
>;

const MAX_LOAD_REPAIR_ATTEMPTS = 2;

/** A run that exits non-zero with no AC-tagged failure — either expected RED or repairable. */
function isCrash(output: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  return parseTestFailuresDetailed(output).taggedFailureCount === 0;
}

/** Dispatch a scoped repair. Dispatch failures leave the crash counting RED. */
async function repairCrash(options: {
  ctx: PipelineContext;
  entry: AcceptanceRedGateEntry;
  output: string;
  deps: AcceptanceRedGateDeps;
}): Promise<boolean> {
  const { ctx, entry, output, deps } = options;
  const previousContent = await deps.readFile(entry.testPath);
  let repair: { testCode: string | null } | null;
  try {
    repair = (await deps.callOp(
      ctx,
      entry.packageDir,
      acceptanceRepairOp,
      { targetTestFilePath: entry.testPath, outputTail: output.slice(-MAX_RAW_TAIL_CHARS), previousContent },
      entry.storyId,
      entry.config,
    )) as { testCode: string | null } | null;
  } catch (err) {
    getSafeLogger()?.warn("acceptance-setup", "RED gate: acceptance repair failed", {
      storyId: entry.storyId,
      testPath: entry.testPath,
      error: errorMessage(err),
    });
    return false;
  }
  if (repair?.testCode != null) await deps.writeFile(entry.testPath, repair.testCode);
  return true;
}

/** Re-run each repair and feed the latest repairable crash into a bounded next turn. */
async function handleCrash(
  ctx: PipelineContext,
  entry: AcceptanceRedGateEntry,
  output: string,
  runCmd: string,
  deps: AcceptanceRedGateDeps,
): Promise<void> {
  const { testPath, language, storyId } = entry;
  const logger = getSafeLogger();
  if (classifyAcceptanceCrash(output, language) === "expected-red") {
    logger?.info("acceptance-setup", "RED gate: compile errors are all missing-symbol — expected RED", {
      storyId,
      testPath,
      language,
    });
    return;
  }
  logger?.warn("acceptance-setup", "RED gate: acceptance file crashed on load — issuing bounded repair turns", {
    storyId,
    testPath,
    language,
  });
  const originalContent = await deps.readFile(testPath);
  let repaired = false;
  try {
    repaired = await repairUntilLoaded({ ctx, entry, output, runCmd, deps });
  } finally {
    if (!repaired && (await deps.readFile(testPath)) !== originalContent) {
      await deps.writeFile(testPath, originalContent);
    }
  }
  await deps.autoCommitIfDirty(
    ctx.workdir,
    "acceptance-setup",
    "pre-run",
    ctx.prd.feature ?? "feature",
    undefined,
    ctx.runtime.dryRun,
  );
}

/** The orchestrator runs the scoped command; the repair session needs no execution tools. */
async function repairUntilLoaded(options: {
  ctx: PipelineContext;
  entry: AcceptanceRedGateEntry;
  output: string;
  runCmd: string;
  deps: AcceptanceRedGateDeps;
}): Promise<boolean> {
  const { ctx, entry, runCmd, deps } = options;
  const { testPath, packageDir, language, storyId, config } = entry;
  let output = options.output;
  for (let attempt = 0; attempt < MAX_LOAD_REPAIR_ATTEMPTS; attempt++) {
    if (!(await repairCrash({ ctx, entry, output, deps }))) return false;
    const verified = await deps.runTest(testPath, packageDir, runCmd, config.acceptance.timeoutMs);
    if (isCommandNotRunnable(verified.exitCode)) {
      getSafeLogger()?.error(
        "acceptance-setup",
        "RED gate: acceptance command could not run — check acceptance.command",
        {
          storyId,
          cmd: runCmd,
          exitCode: verified.exitCode,
        },
      );
      return false;
    }
    if (
      !isCrash(verified.output, verified.exitCode) ||
      classifyAcceptanceCrash(verified.output, language) === "expected-red"
    )
      return true;
    output = verified.output;
  }
  getSafeLogger()?.warn("acceptance-setup", "RED gate: acceptance file still crashes after repair", {
    storyId,
    testPath,
  });
  return false;
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
      cmd: runCmd,
      packageDir,
    });

    const first = await deps.runTest(testPath, packageDir, runCmd, config.acceptance.timeoutMs);
    if (first.exitCode === 0) continue;

    // Exit 126 / 127: the shell itself could not run the command. The runner
    // never started, so the test file is not to blame — name it and move on,
    // skipping both the repair turn and the re-run. The entry still counts
    // RED (this branch is reached on a non-zero exit, so `redFailCount++`
    // below applies).
    if (isCommandNotRunnable(first.exitCode)) {
      logger?.error("acceptance-setup", "RED gate: acceptance command could not run — check acceptance.command", {
        storyId: entry.storyId,
        cmd: runCmd,
        exitCode: first.exitCode,
      });
      redFailCount++;
      continue;
    }

    if (isCrash(first.output, first.exitCode)) {
      await handleCrash(ctx, entry, first.output, runCmd, deps);
    }
    redFailCount++;
  }

  return redFailCount;
}
