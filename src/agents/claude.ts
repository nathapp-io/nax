/**
 * Claude Code Agent Adapter
 */

import { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import { buildDecomposePrompt, parseDecomposeOutput } from "./claude-decompose";
import { runPlan } from "./claude-plan";
import { estimateCostByDuration, estimateCostFromOutput } from "./cost";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  DecomposeOptions,
  DecomposeResult,
  InteractiveRunOptions,
  PlanOptions,
  PlanResult,
  PtyHandle,
} from "./types";

/**
 * Maximum characters to capture from agent stdout.
 *
 * Last 5000 chars typically contain the most relevant info (final status, summary, errors).
 * This limit prevents memory bloat while preserving actionable output.
 */
const MAX_AGENT_OUTPUT_CHARS = 5000;

/**
 * Maximum characters to capture from agent stderr.
 *
 * Last 1000 chars typically contain the actual error message (e.g., 401, 500, crash).
 * Smaller than stdout since stderr is more focused on errors.
 */
const MAX_AGENT_STDERR_CHARS = 1000;

/**
 * Claude Code agent adapter implementation.
 *
 * Implements the AgentAdapter interface for Claude Code CLI,
 * supporting model routing, rate limit retry, and cost tracking.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly binary = "claude";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
    features: new Set(["tdd", "review", "refactor", "batch"]),
  };

  private pidRegistries: Map<string, PidRegistry> = new Map();

  private getPidRegistry(workdir: string): PidRegistry {
    if (!this.pidRegistries.has(workdir)) {
      this.pidRegistries.set(workdir, new PidRegistry(workdir));
    }
    const registry = this.pidRegistries.get(workdir);
    if (!registry) {
      throw new Error(`PidRegistry not found for workdir: ${workdir}`);
    }
    return registry;
  }

  async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", this.binary], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    } catch (error) {
      const logger = getLogger();
      logger?.debug("agent", "Failed to check if agent is installed", { error });
      return false;
    }
  }

  buildCommand(options: AgentRunOptions): string[] {
    const model = options.modelDef.model;
    const skipPermissions = options.dangerouslySkipPermissions ?? true;
    const permArgs = skipPermissions ? ["--dangerously-skip-permissions"] : [];
    return [this.binary, "--model", model, ...permArgs, "-p", options.prompt];
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.runOnce(options, attempt);

        if (result.rateLimited && attempt < maxRetries) {
          const backoffMs = 2 ** attempt * 1000;
          const logger = getLogger();
          logger.warn("agent", "Rate limited, retrying", { backoffSeconds: backoffMs / 1000, attempt, maxRetries });
          await Bun.sleep(backoffMs);
          continue;
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        const isSpawnError = lastError.message.includes("spawn") || lastError.message.includes("ENOENT");

        if (isSpawnError && attempt < maxRetries) {
          const backoffMs = 2 ** attempt * 1000;
          const logger = getLogger();
          logger.warn("agent", "Agent spawn error, retrying", {
            error: lastError.message,
            backoffSeconds: backoffMs / 1000,
            attempt,
            maxRetries,
          });
          await Bun.sleep(backoffMs);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Agent execution failed after all retries");
  }

  /**
   * Build allowed environment variables for spawned agents.
   * SEC-4: Only pass essential env vars to prevent leaking sensitive data.
   */
  buildAllowedEnv(options: AgentRunOptions): Record<string, string | undefined> {
    const allowed: Record<string, string | undefined> = {};

    const essentialVars = ["PATH", "HOME", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];
    for (const varName of essentialVars) {
      if (process.env[varName]) {
        allowed[varName] = process.env[varName];
      }
    }

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

  private async runOnce(options: AgentRunOptions, _attempt: number): Promise<AgentResult> {
    const cmd = this.buildCommand(options);
    const startTime = Date.now();

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "inherit", // MEM-3: Inherit stderr to avoid blocking on unread pipe
      env: this.buildAllowedEnv(options),
    });

    const processPid = proc.pid;
    const pidRegistry = this.getPidRegistry(options.workdir);
    await pidRegistry.register(processPid);

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    await pidRegistry.unregister(processPid);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Date.now() - startTime;

    const rateLimited =
      stderr.includes("rate limit") ||
      stderr.includes("429") ||
      stdout.includes("rate limit") ||
      stdout.includes("Too many requests");

    const fullOutput = stdout + stderr;
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

  async plan(options: PlanOptions): Promise<PlanResult> {
    const pidRegistry = this.getPidRegistry(options.workdir);
    return runPlan(this.binary, options, pidRegistry, this.buildAllowedEnv.bind(this));
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const prompt = buildDecomposePrompt(options);

    const cmd = [
      this.binary,
      "--model",
      options.modelDef?.model || "claude-sonnet-4-5",
      "--dangerously-skip-permissions",
      "-p",
      prompt,
    ];

    const pidRegistry = this.getPidRegistry(options.workdir);

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "inherit", // MEM-3: Inherit stderr to avoid blocking on unread pipe
      env: this.buildAllowedEnv({
        workdir: options.workdir,
        modelDef: options.modelDef || { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
        prompt: "",
        modelTier: "balanced",
        timeoutSeconds: 600,
      }),
    });

    await pidRegistry.register(proc.pid);

    const exitCode = await proc.exited;

    await pidRegistry.unregister(proc.pid);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`Decompose failed with exit code ${exitCode}: ${stderr}`);
    }

    const stories = parseDecomposeOutput(stdout);

    return { stories };
  }

  runInteractive(options: InteractiveRunOptions): PtyHandle {
    const model = options.modelDef.model;
    const cmd = [this.binary, "--model", model, options.prompt];

    // BUN-001: Replaced node-pty with Bun.spawn (piped stdio).
    // runInteractive() is TUI-only and currently dormant in headless nax runs.
    // TERM + FORCE_COLOR preserve formatting output from Claude Code.
    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      env: { ...this.buildAllowedEnv(options), TERM: "xterm-256color", FORCE_COLOR: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // MEM-3: Inherit stderr to avoid blocking on unread pipe
    });

    const pidRegistry = this.getPidRegistry(options.workdir);
    pidRegistry.register(proc.pid).catch(() => {});

    // Stream stdout to onOutput callback
    (async () => {
      try {
        for await (const chunk of proc.stdout) {
          options.onOutput(Buffer.from(chunk));
        }
      } catch (err) {
        // BUG-21: Handle stream errors to avoid unhandled rejections
        getLogger()?.error("agent", "runInteractive stdout error", { err });
      }
    })();

    // Fire onExit when process completes
    proc.exited
      .then((code) => {
        pidRegistry.unregister(proc.pid).catch(() => {});
        options.onExit(code ?? 1);
      })
      .catch((err) => {
        // BUG-22: Guard against onExit or unregister throws
        getLogger()?.error("agent", "runInteractive exit error", { err });
      });

    return {
      write: (data: string) => {
        proc.stdin.write(data);
      },
      resize: (_cols: number, _rows: number) => {
        /* no-op: Bun.spawn has no PTY resize */
      },
      kill: () => {
        proc.kill();
      },
      pid: proc.pid,
    };
  }
}
