/**
 * Hook Runner
 *
 * Loads hooks.json and executes hooks at lifecycle events.
 */

import { join } from "node:path";
import { buildAllowedEnv } from "../agents/shared/env";
import { getLogger } from "../logger";
import { parseCommandToArgv } from "../utils/command-argv";
import { loadJsonFile } from "../utils/json-file";
import { killProcessGroup } from "../utils/process-kill";
import type { HookContext, HookDef, HookEvent, HooksConfig } from "./types";

const DEFAULT_TIMEOUT = 5000;

/** Extended hooks config that tracks global vs project hooks */
export interface LoadedHooksConfig extends HooksConfig {
  /** Global hooks (loaded from ~/.nax/hooks.json) */
  _global?: HooksConfig;
  /** Whether global hooks were skipped */
  _skipGlobal?: boolean;
}

/**
 * Load hooks config from global and project paths.
 *
 * Both global and project hooks are preserved independently (not merged).
 * The skipGlobal flag in project config disables global hook loading.
 *
 * @param projectDir - Project nax directory path
 * @param globalDir - Global nax directory path (optional)
 * @returns Merged hooks config with both global and project hooks
 */
export async function loadHooksConfig(projectDir: string, globalDir?: string): Promise<LoadedHooksConfig> {
  let globalHooks: HooksConfig = { hooks: {} };
  let projectHooks: HooksConfig = { hooks: {} };
  let skipGlobal = false;

  // Load project hooks first to check skipGlobal flag
  const projectPath = join(projectDir, "hooks.json");
  const projectData = await loadJsonFile<HooksConfig & { skipGlobal?: boolean }>(projectPath, "hooks");
  if (projectData) {
    projectHooks = projectData;
    // Check if project config has skipGlobal flag
    skipGlobal = projectData.skipGlobal ?? false;
  }

  // Load global hooks only if not skipped
  if (!skipGlobal && globalDir) {
    const globalPath = join(globalDir, "hooks.json");
    const globalData = await loadJsonFile<HooksConfig>(globalPath, "hooks");
    if (globalData) {
      globalHooks = globalData;
    }
  }

  // Return project hooks as the main config, with global hooks stored separately
  return {
    ...projectHooks,
    _global: skipGlobal ? undefined : globalHooks,
    _skipGlobal: skipGlobal,
  };
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
export function hasShellOperators(command: string): boolean {
  // Check for common shell operators that require shell interpretation
  const shellOperators = /[|&;$`<>(){}]/;
  return shellOperators.test(command);
}

/**
 * Validate hook command for injection patterns
 * @param command - Command string to validate
 * @throws Error if obvious injection pattern detected
 */
export function validateHookCommand(command: string): void {
  // Reject commands with obvious injection patterns
  const dangerousPatterns = [
    /\$\([^)]*\)/, // Command substitution $(...) — bounded to avoid ReDoS
    /`[^`]*`/, // Backtick command substitution — bounded to avoid ReDoS
    /\|\s*bash/, // Piping to bash
    /\|\s*sh/, // Piping to sh
    /;\s*rm\s+-rf/, // Dangerous deletion
    /&&\s*rm\s+-rf/, // Dangerous deletion after success
    /\beval\s+/, // SEC-3 fix: eval command
    /curl\s+[^|]*\|\s*/, // SEC-3 fix: curl piping
    /python\s+-c/, // SEC-3 fix: python -c execution
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Hook command contains dangerous pattern: ${pattern.source}`);
    }
  }
}

export { parseCommandToArgv };

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
  const logger = getLogger();
  if (hasShellOperators(hookDef.command)) {
    logger.warn("hooks", "[SECURITY] Hook command contains shell operators", {
      command: hookDef.command,
      warning: "Shell operators may enable injection attacks. Consider using simple commands only.",
    });
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
    env: buildAllowedEnv({ env }),
  });

  // Timeout handling
  const timeoutId = setTimeout(() => {
    killProcessGroup(proc.pid, "SIGTERM");
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

/**
 * Fire a hook event for both global and project hooks.
 *
 * Both hooks fire independently - global failure doesn't block project hook.
 *
 * @param config - Loaded hooks config (contains both global and project hooks)
 * @param event - Hook event name
 * @param ctx - Hook context
 * @param workdir - Working directory
 */
export async function fireHook(
  config: LoadedHooksConfig,
  event: HookEvent,
  ctx: HookContext,
  workdir: string,
): Promise<void> {
  const logger = getLogger();

  // Fire global hook first (if present and not skipped)
  if (config._global && !config._skipGlobal) {
    const globalHookDef = config._global.hooks[event];
    if (globalHookDef && globalHookDef.enabled !== false) {
      try {
        const result = await executeHook(globalHookDef, { ...ctx, event }, workdir);
        if (!result.success) {
          logger.warn("hooks", `Global hook ${event} failed`, { event, output: result.output });
        }
      } catch (err) {
        logger.warn("hooks", `Global hook ${event} error`, { event, error: String(err) });
      }
    }
  }

  // Fire project hook (independent of global hook result)
  const projectHookDef = config.hooks?.[event];
  if (projectHookDef && projectHookDef.enabled !== false) {
    try {
      const result = await executeHook(projectHookDef, { ...ctx, event }, workdir);
      if (!result.success) {
        logger.warn("hooks", `Project hook ${event} failed`, { event, output: result.output });
      }
    } catch (err) {
      logger.warn("hooks", `Project hook ${event} error`, { event, error: String(err) });
    }
  }
}
