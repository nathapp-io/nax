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

/** Build environment variables from hook context */
function buildEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    NGENT_EVENT: ctx.event,
    NGENT_FEATURE: ctx.feature,
  };

  if (ctx.storyId) env.NGENT_STORY_ID = ctx.storyId;
  if (ctx.status) env.NGENT_STATUS = ctx.status;
  if (ctx.reason) env.NGENT_REASON = ctx.reason;
  if (ctx.cost !== undefined) env.NGENT_COST = ctx.cost.toFixed(4);
  if (ctx.model) env.NGENT_MODEL = ctx.model;
  if (ctx.agent) env.NGENT_AGENT = ctx.agent;
  if (ctx.iteration !== undefined) env.NGENT_ITERATION = String(ctx.iteration);

  return env;
}

/** Execute a single hook */
async function executeHook(
  hookDef: HookDef,
  ctx: HookContext,
  workdir: string,
): Promise<{ success: boolean; output: string }> {
  if (hookDef.enabled === false) {
    return { success: true, output: "(disabled)" };
  }

  const timeout = hookDef.timeout ?? DEFAULT_TIMEOUT;
  const env = buildEnv(ctx);

  // Pass full context as JSON via stdin
  const contextJson = JSON.stringify(ctx);

  const proc = Bun.spawn(["bash", "-c", hookDef.command], {
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

  return {
    success: exitCode === 0,
    output: (stdout + stderr).trim(),
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
