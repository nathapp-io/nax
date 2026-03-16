import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Claude Code Plan Logic
 *
 * Extracted from claude.ts: plan(), buildPlanCommand()
 */

import { resolvePermissions } from "../../config/permissions";
import type { PidRegistry } from "../../execution/pid-registry";
import { withProcessTimeout } from "../../execution/timeout-handler";
import { getLogger } from "../../logger";
import { resolveBalancedModelDef } from "../shared/model-resolution";
import type { PlanOptions, PlanResult } from "../shared/types-extended";
import type { AgentRunOptions } from "../types";

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

  // For non-interactive mode, include input file content in the prompt
  if (options.inputFile) {
    try {
      const inputContent = require("node:fs").readFileSync(
        require("node:path").resolve(options.workdir, options.inputFile),
        "utf-8",
      );
      fullPrompt = `${fullPrompt}\n\n## Input Requirements\n\n${inputContent}`;
    } catch (error) {
      throw new Error(`Failed to read input file ${options.inputFile}: ${(error as Error).message}`);
    }
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
export async function runPlan(
  binary: string,
  options: PlanOptions,
  pidRegistry: PidRegistry,
  buildAllowedEnv: (options: AgentRunOptions) => Record<string, string | undefined>,
): Promise<PlanResult> {
  const { resolveBalancedModelDef } = await import("../shared/model-resolution");

  const cmd = buildPlanCommand(binary, options);

  // Resolve model: explicit modelDef > config.models.balanced > throw
  let modelDef = options.modelDef;
  if (!modelDef) {
    if (!options.config) {
      throw new Error("runPlan() requires either modelDef or config with models.balanced configured");
    }
    modelDef = resolveBalancedModelDef(options.config);
  }

  const envOptions: AgentRunOptions = {
    workdir: options.workdir,
    modelDef,
    prompt: "",
    modelTier: options.modelTier || "balanced",
    timeoutSeconds: 600,
  };

  const PLAN_TIMEOUT_MS = 600_000; // 10 minutes

  if (options.interactive) {
    // Interactive mode: inherit stdio
    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: buildAllowedEnv(envOptions),
    });

    // Register PID
    await pidRegistry.register(proc.pid);

    let exitCode: number;
    try {
      const timeoutResult = await withProcessTimeout(proc, PLAN_TIMEOUT_MS, {
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
      env: buildAllowedEnv(envOptions),
    });

    // Register PID
    await pidRegistry.register(proc.pid);

    let exitCode: number;
    try {
      const timeoutResult = await withProcessTimeout(proc, PLAN_TIMEOUT_MS, {
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
