/**
 * Claude Code Agent - Execution Layer
 *
 * Handles building commands, preparing environment, and process execution.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { resolvePermissions } from "../../config/permissions";
import type { PidRegistry } from "../../execution/pid-registry";
import { withProcessTimeout } from "../../execution/timeout-handler";
import { getLogger } from "../../logger";
import type { AgentResult, AgentRunOptions } from "../types";
import { estimateCostByDuration, estimateCostFromOutput } from "./cost";

/**
 * Maximum characters to capture from agent stdout.
 */
const MAX_AGENT_OUTPUT_CHARS = 5000;

/**
 * Maximum characters to capture from agent stderr.
 */
const MAX_AGENT_STDERR_CHARS = 1000;

/**
 * Grace period in ms between SIGTERM and SIGKILL on timeout.
 */
const SIGKILL_GRACE_PERIOD_MS = 5000;

/**
 * Injectable dependencies for runOnce() — allows tests to verify
 * that PID cleanup (unregister) always runs even if kill() throws.
 *
 * @internal
 */
export const _runOnceDeps = {
  killProc(proc: { kill(signal?: number | NodeJS.Signals): void }, signal: NodeJS.Signals): void {
    proc.kill(signal);
  },
  buildCmd(binary: string, options: AgentRunOptions): string[] {
    return buildCommand(binary, options);
  },
  spawn(
    cmd: string[],
    opts: { cwd: string; stdout: "pipe"; stderr: "inherit"; env: Record<string, string | undefined> },
  ): {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  } {
    return Bun.spawn(cmd, opts) as unknown as {
      pid: number;
      stdout: ReadableStream<Uint8Array>;
      stderr?: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      kill(signal?: number | NodeJS.Signals): void;
    };
  },
};

/**
 * Build Claude Code command with model and permissions.
 *
 * @param binary - Path to claude binary
 * @param options - Agent run options
 * @returns Command array for Bun.spawn()
 */
export function buildCommand(binary: string, options: AgentRunOptions): string[] {
  const model = options.modelDef.model;
  const { skipPermissions } = resolvePermissions(options.config, options.pipelineStage ?? "run");
  const permArgs = skipPermissions ? ["--dangerously-skip-permissions"] : [];
  return [binary, "--model", model, ...permArgs, "-p", options.prompt];
}

/**
 * Build allowed environment variables for spawned agents.
 * SEC-4: Only pass essential env vars to prevent leaking sensitive data.
 *
 * @param options - Agent run options
 * @returns Filtered environment variables
 */
export function buildAllowedEnv(options: AgentRunOptions): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};

  const essentialVars = ["PATH", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];
  for (const varName of essentialVars) {
    if (process.env[varName]) {
      allowed[varName] = process.env[varName];
    }
  }

  // Sanitize HOME — must be absolute path. Unexpanded "~" causes literal ~/dir in cwd.
  const rawHome = process.env.HOME ?? "";
  const safeHome = rawHome && isAbsolute(rawHome) ? rawHome : homedir();
  if (rawHome !== safeHome) {
    const logger = getLogger();
    logger.warn("env", `HOME env is not absolute ("${rawHome}"), falling back to os.homedir(): ${safeHome}`);
  }
  allowed.HOME = safeHome;

  const apiKeyVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  for (const varName of apiKeyVars) {
    if (process.env[varName]) {
      allowed[varName] = process.env[varName];
    }
  }

  const allowedPrefixes = ["CLAUDE_", "NAX_", "CLAW_", "TURBO_"];
  for (const [key, value] of Object.entries(process.env)) {
    if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
      allowed[key] = value;
    }
  }

  if (options.modelDef.env) {
    Object.assign(allowed, options.modelDef.env);
  }

  if (options.env) {
    Object.assign(allowed, options.env);
  }

  return allowed;
}

/**
 * Execute agent process once with timeout and signal handling.
 *
 * @param binary - Path to claude binary
 * @param options - Agent run options
 * @param pidRegistry - PID registry for cleanup
 * @returns Agent execution result
 *
 * @internal
 */
export async function executeOnce(
  binary: string,
  options: AgentRunOptions,
  pidRegistry: PidRegistry,
): Promise<AgentResult> {
  const cmd = _runOnceDeps.buildCmd(binary, options);
  const startTime = Date.now();

  // Log session-related options for traceability. CLI adapter doesn't use sessions,
  // but the pipeline passes these uniformly. Logged so future CLI session support
  // can verify they're threaded correctly.
  if (options.sessionRole || options.acpSessionName || options.keepSessionOpen) {
    const logger = getLogger();
    logger.debug("agent", "CLI mode: session options received (unused)", {
      sessionRole: options.sessionRole,
      acpSessionName: options.acpSessionName,
      keepSessionOpen: options.keepSessionOpen,
      featureName: options.featureName,
      storyId: options.storyId,
    });
  }

  const proc = _runOnceDeps.spawn(cmd, {
    cwd: options.workdir,
    stdout: "pipe",
    stderr: "inherit",
    env: buildAllowedEnv(options),
  });

  const processPid = proc.pid;
  await pidRegistry.register(processPid);

  let timedOut = false;
  let exitCode: number;
  try {
    const timeoutResult = await withProcessTimeout(proc, options.timeoutSeconds * 1000, {
      graceMs: SIGKILL_GRACE_PERIOD_MS,
      onTimeout: () => {
        timedOut = true;
      },
      killFn: (p, signal) => _runOnceDeps.killProc(p, signal),
    });
    exitCode = timeoutResult.exitCode;
    timedOut = timeoutResult.timedOut;
  } finally {
    await pidRegistry.unregister(processPid);
  }

  let stdoutTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const stdout = await Promise.race([
    new Response(proc.stdout).text(),
    new Promise<string>((resolve) => {
      stdoutTimeoutId = setTimeout(() => resolve(""), 5000);
    }),
  ]);
  clearTimeout(stdoutTimeoutId); // prevent leaked timer when stdout resolves first
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const durationMs = Date.now() - startTime;

  const fullOutput = stdout + stderr;
  const rateLimited =
    fullOutput.toLowerCase().includes("rate limit") ||
    fullOutput.includes("429") ||
    fullOutput.toLowerCase().includes("too many requests");

  let costEstimate = estimateCostFromOutput(options.modelTier, fullOutput);
  const logger = getLogger();
  if (!costEstimate) {
    const fallbackEstimate = estimateCostByDuration(options.modelTier, durationMs);
    costEstimate = {
      cost: fallbackEstimate.cost * 1.5,
      confidence: "fallback",
    };
    logger.warn("agent", "Cost estimation fallback (duration-based)", {
      modelTier: options.modelTier,
      cost: costEstimate.cost,
    });
  } else if (costEstimate.confidence === "estimated") {
    logger.warn("agent", "Cost estimation using regex parsing (estimated confidence)", { cost: costEstimate.cost });
  }
  const cost = costEstimate.cost;

  const actualExitCode = timedOut ? 124 : exitCode;

  return {
    success: exitCode === 0 && !timedOut,
    exitCode: actualExitCode,
    output: stdout.slice(-MAX_AGENT_OUTPUT_CHARS),
    stderr: stderr.slice(-MAX_AGENT_STDERR_CHARS),
    rateLimited,
    durationMs,
    estimatedCost: cost,
    pid: processPid,
  };
}
