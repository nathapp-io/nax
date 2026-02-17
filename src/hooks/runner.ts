/**
 * Hook Runner
 *
 * Loads hooks.json and executes hooks at lifecycle events.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookContext, HookDef, HookEvent, HooksConfig } from "./types";

const DEFAULT_TIMEOUT = 5000;

/** Load hooks config from project or global path */
export async function loadHooksConfig(
  projectDir: string,
  globalDir?: string,
): Promise<HooksConfig> {
  const merged: HooksConfig = { hooks: {} };

  // Load global hooks first
  if (globalDir) {
    const globalPath = join(globalDir, "hooks.json");
    if (existsSync(globalPath)) {
      const global: HooksConfig = await Bun.file(globalPath).json();
      Object.assign(merged.hooks, global.hooks);
    }
  }

  // Project hooks override global
  const projectPath = join(projectDir, "hooks.json");
  if (existsSync(projectPath)) {
    const project: HooksConfig = await Bun.file(projectPath).json();
    Object.assign(merged.hooks, project.hooks);
  }

  return merged;
}

/**
 * Escape environment variable values to prevent injection
 * @param value - Raw value to escape
 * @returns Escaped value safe for subprocess environment
 */
function escapeEnvValue(value: string): string {
  // Remove null bytes and newlines that could cause issues
  return value.replace(/\0/g, "").replace(/\n/g, " ").replace(/\r/g, "");
}

/**
 * Build environment variables from hook context
 * All values are escaped to prevent injection attacks
 */
function buildEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    NAX_EVENT: escapeEnvValue(ctx.event),
    NAX_FEATURE: escapeEnvValue(ctx.feature),
  };

  if (ctx.storyId) env.NAX_STORY_ID = escapeEnvValue(ctx.storyId);
  if (ctx.status) env.NAX_STATUS = escapeEnvValue(ctx.status);
  if (ctx.reason) env.NAX_REASON = escapeEnvValue(ctx.reason);
  if (ctx.cost !== undefined) env.NAX_COST = ctx.cost.toFixed(4);
  if (ctx.model) env.NAX_MODEL = escapeEnvValue(ctx.model);
  if (ctx.agent) env.NAX_AGENT = escapeEnvValue(ctx.agent);
  if (ctx.iteration !== undefined) env.NAX_ITERATION = String(ctx.iteration);

  return env;
}

/**
 * Detect shell operators that indicate shell interpolation
 * @param command - Command string to check
 * @returns true if shell operators detected
 */
function hasShellOperators(command: string): boolean {
  // Check for common shell operators that require shell interpretation
  const shellOperators = /[|&;$`<>(){}]/;
  return shellOperators.test(command);
}

/**
 * Validate hook command for injection patterns
 * @param command - Command string to validate
 * @throws Error if obvious injection pattern detected
 */
function validateHookCommand(command: string): void {
  // Reject commands with obvious injection patterns
  const dangerousPatterns = [
    /\$\(.*\)/, // Command substitution $(...)
    /`.*`/, // Backtick command substitution
    /\|\s*bash/, // Piping to bash
    /\|\s*sh/, // Piping to sh
    /;\s*rm\s+-rf/, // Dangerous deletion
    /&&\s*rm\s+-rf/, // Dangerous deletion after success
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      throw new Error(
        `Hook command contains dangerous pattern: ${pattern.source}`,
      );
    }
  }
}

/**
 * Parse command string into argv array
 * Simple space-based splitting (does not handle complex quoting)
 * @param command - Command string
 * @returns Array of command and arguments
 */
function parseCommandToArgv(command: string): string[] {
  return command.trim().split(/\s+/);
}

/**
 * Execute a single hook
 *
 * SECURITY WARNING: Hook commands are executed as subprocesses.
 * - Commands are parsed into argv arrays to avoid shell injection
 * - Shell operators (|, &&, ;, $, etc.) trigger a security warning
 * - Obvious injection patterns are rejected
 * - Environment variables are escaped
 * - Only configure hooks from trusted sources
 *
 * @param hookDef - Hook definition from config
 * @param ctx - Hook context with environment variables
 * @param workdir - Working directory for command execution
 * @returns Promise with success status and output
 */
async function executeHook(
  hookDef: HookDef,
  ctx: HookContext,
  workdir: string,
): Promise<{ success: boolean; output: string }> {
  if (hookDef.enabled === false) {
    return { success: true, output: "(disabled)" };
  }

  // Validate command for injection patterns
  try {
    validateHookCommand(hookDef.command);
  } catch (err) {
    return {
      success: false,
      output: `Security validation failed: ${err}`,
    };
  }

  // Warn if shell operators detected
  if (hasShellOperators(hookDef.command)) {
    console.warn(
      `[SECURITY] Hook command contains shell operators: ${hookDef.command}`,
    );
    console.warn(
      "[SECURITY] Shell operators may enable injection attacks. Consider using simple commands only.",
    );
  }

  const timeout = hookDef.timeout ?? DEFAULT_TIMEOUT;
  const env = buildEnv(ctx);

  // Pass full context as JSON via stdin
  const contextJson = JSON.stringify(ctx);

  // Parse command to argv array (no shell interpolation)
  const argv = parseCommandToArgv(hookDef.command);
  if (argv.length === 0) {
    return { success: false, output: "Empty command" };
  }

  const proc = Bun.spawn(argv, {
    cwd: workdir,
    stdin: new Response(contextJson),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  // Timeout handling
  const timeoutId = setTimeout(() => {
    proc.kill("SIGTERM");
  }, timeout);

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const output = (stdout + stderr).trim();

  // Check if process was killed by timeout
  if (exitCode !== 0 && output === "") {
    return {
      success: false,
      output: `Hook timed out after ${timeout}ms`,
    };
  }

  return {
    success: exitCode === 0,
    output,
  };
}

/** Fire a hook event */
export async function fireHook(
  config: HooksConfig,
  event: HookEvent,
  ctx: HookContext,
  workdir: string,
): Promise<void> {
  const hookDef = config.hooks[event];
  if (!hookDef || hookDef.enabled === false) return;

  try {
    const result = await executeHook(hookDef, { ...ctx, event }, workdir);
    if (!result.success) {
      console.warn(`Hook ${event} failed: ${result.output}`);
    }
  } catch (err) {
    console.warn(`Hook ${event} error: ${err}`);
  }
}
