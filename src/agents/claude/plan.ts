import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
/**
 * Claude Code Plan Logic
 *
 * Extracted from claude.ts: plan(), buildPlanCommand()
 */

import { validateFilePath } from "../../config/path-security";
import { resolvePermissions } from "../../config/permissions";
import type { PidRegistry } from "../../execution/pid-registry";
import { withProcessTimeout } from "../../execution/timeout-handler";
import { getLogger } from "../../logger";
import { buildAllowedEnv } from "../shared/env";
import { resolveBalancedModelDef } from "../shared/model-resolution";
import type { PlanOptions, PlanResult } from "../shared/types-extended";

/**
 * Build the CLI command for plan mode.
 */
export function buildPlanCommand(binary: string, options: PlanOptions): string[] {
  const cmd = [binary, "--permission-mode", "plan"];

  // Add model if specified (explicit or resolved from config)
  let modelDef = options.modelDef;
  if (!modelDef && options.config) {
    modelDef = resolveBalancedModelDef(options.config);
  }

  if (modelDef) {
    cmd.push("--model", modelDef.model);
  }

  // Resolve permission mode from config
  const { skipPermissions } = resolvePermissions(
    options.config as import("../../config").NaxConfig | undefined,
    "plan",
  );
  if (skipPermissions) {
    cmd.push("--dangerously-skip-permissions");
  }

  // Add prompt with codebase context and input file if available
  let fullPrompt = options.prompt;
  if (options.codebaseContext) {
    fullPrompt = `${options.codebaseContext}\n\n${options.prompt}`;
  }

  // Append pre-read input file content when provided (populated by runPlan before this call)
  if (options.resolvedInputContent) {
    fullPrompt = `${fullPrompt}\n\n## Input Requirements\n\n${options.resolvedInputContent}`;
  }

  if (!options.interactive) {
    cmd.push("-p", fullPrompt);
  } else {
    // Interactive mode: pass prompt as initial message, agent will ask follow-ups
    cmd.push("-p", fullPrompt);
  }

  return cmd;
}

/**
 * Run Claude Code in plan mode to generate a feature specification.
 */
export async function runPlan(binary: string, options: PlanOptions, pidRegistry: PidRegistry): Promise<PlanResult> {
  const { resolveBalancedModelDef } = await import("../shared/model-resolution");

  // Read inputFile here (async, with path boundary check) so buildPlanCommand
  // stays synchronous and never touches the filesystem directly.
  let resolvedOptions = options;
  if (options.inputFile) {
    const inputPath = validateFilePath(resolve(options.workdir, options.inputFile), options.workdir);
    const resolvedInputContent = await Bun.file(inputPath).text();
    resolvedOptions = { ...options, resolvedInputContent };
  }

  const cmd = buildPlanCommand(binary, resolvedOptions);

  // Resolve model: explicit modelDef > config.models.balanced > throw
  let modelDef = options.modelDef;
  if (!modelDef) {
    if (!options.config) {
      throw new Error("runPlan() requires either modelDef or config with models.balanced configured");
    }
    modelDef = resolveBalancedModelDef(options.config);
  }

  // buildAllowedEnv reads only modelEnv/env; plan path provides neither.

  const planTimeoutMs = (options.timeoutSeconds ?? 600) * 1000;

  if (options.interactive) {
    // Interactive mode: inherit stdio
    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: buildAllowedEnv(),
    });

    // Register PID
    await pidRegistry.register(proc.pid);

    let exitCode: number;
    try {
      const timeoutResult = await withProcessTimeout(proc, planTimeoutMs, {
        graceMs: 5000,
      });
      exitCode = timeoutResult.exitCode;
    } finally {
      // Unregister PID after exit
      await pidRegistry.unregister(proc.pid);
    }

    if (exitCode !== 0) {
      throw new Error(`Plan mode failed with exit code ${exitCode}`);
    }
    return { specContent: "", conversationLog: "" };
  }

  // Non-interactive: redirect stdout to temp file via Bun.file()

  const tempDir = mkdtempSync(join(tmpdir(), "nax-plan-"));
  const outFile = join(tempDir, "stdout.txt");
  const errFile = join(tempDir, "stderr.txt");

  try {
    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdin: "ignore",
      stdout: Bun.file(outFile),
      stderr: Bun.file(errFile),
      env: buildAllowedEnv(),
    });

    // Register PID
    await pidRegistry.register(proc.pid);

    let exitCode: number;
    try {
      const timeoutResult = await withProcessTimeout(proc, planTimeoutMs, {
        graceMs: 5000,
      });
      exitCode = timeoutResult.exitCode;
    } finally {
      // Unregister PID after exit
      await pidRegistry.unregister(proc.pid);
    }

    const specContent = await Bun.file(outFile).text();
    const conversationLog = await Bun.file(errFile).text();

    if (exitCode !== 0) {
      throw new Error(`Plan mode failed with exit code ${exitCode}: ${conversationLog || "unknown error"}`);
    }

    return { specContent, conversationLog };
  } finally {
    try {
      rmSync(tempDir, { recursive: true });
    } catch (error) {
      const logger = getLogger();
      logger?.debug("agent", "Failed to clean up temp directory", { error, tempDir });
    }
  }
}
