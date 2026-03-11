/**
 * Claude Code Agent Adapter
 *
 * Main adapter class coordinating execution, completion, decomposition, and interactive modes.
 */

import { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import { _completeDeps, executeComplete } from "./claude-complete";
import { buildDecomposePrompt, parseDecomposeOutput } from "./claude-decompose";
import { _runOnceDeps, buildAllowedEnv, buildCommand, executeOnce } from "./claude-execution";
import { runInteractiveMode } from "./claude-interactive";
import { runPlan } from "./claude-plan";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  DecomposeOptions,
  DecomposeResult,
  InteractiveRunOptions,
  PlanOptions,
  PlanResult,
  PtyHandle,
} from "./types";

/**
 * Injectable dependencies for decompose() — allows tests to intercept
 * Bun.spawn calls and verify correct CLI args without the claude binary.
 *
 * @internal
 */
export const _decomposeDeps = {
  spawn(
    cmd: string[],
    opts: { cwd?: string; stdout: "pipe"; stderr: "inherit" | "pipe"; env?: Record<string, string | undefined> },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    pid: number;
    kill(signal?: NodeJS.Signals | number): void;
  } {
    return Bun.spawn(cmd, opts) as unknown as {
      stdout: ReadableStream<Uint8Array>;
      stderr?: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      pid: number;
      kill(signal?: NodeJS.Signals | number): void;
    };
  },
};

// Re-export deps for testing
export { _runOnceDeps, _completeDeps };

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
    return buildCommand(this.binary, options);
  }

  buildAllowedEnv(options: AgentRunOptions): Record<string, string | undefined> {
    return buildAllowedEnv(options);
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const pidRegistry = this.getPidRegistry(options.workdir);
        const result = await executeOnce(this.binary, options, pidRegistry);

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

  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    return executeComplete(this.binary, prompt, options);
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    const pidRegistry = this.getPidRegistry(options.workdir);
    return runPlan(this.binary, options, pidRegistry, this.buildAllowedEnv.bind(this));
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const { resolveBalancedModelDef } = await import("./model-resolution");

    const prompt = buildDecomposePrompt(options);

    let modelDef = options.modelDef;
    if (!modelDef) {
      if (!options.config) {
        throw new Error("decompose() requires either modelDef or config with models.balanced configured");
      }
      modelDef = resolveBalancedModelDef(options.config);
    }

    const cmd = [this.binary, "--model", modelDef.model, "--dangerously-skip-permissions", "-p", prompt];

    const pidRegistry = this.getPidRegistry(options.workdir);

    const proc = _decomposeDeps.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "inherit",
      env: this.buildAllowedEnv({
        workdir: options.workdir,
        modelDef,
        prompt: "",
        modelTier: options.modelTier || "balanced",
        timeoutSeconds: 600,
      }),
    });

    await pidRegistry.register(proc.pid);

    const DECOMPOSE_TIMEOUT_MS = 300_000;
    let timedOut = false;
    const decomposeTimerId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 5000);
    }, DECOMPOSE_TIMEOUT_MS);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } finally {
      clearTimeout(decomposeTimerId);
      await pidRegistry.unregister(proc.pid);
    }

    if (timedOut) {
      throw new Error(`Decompose timed out after ${DECOMPOSE_TIMEOUT_MS / 1000}s`);
    }

    const stdout = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
    ]);
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`Decompose failed with exit code ${exitCode}: ${stderr}`);
    }

    const stories = parseDecomposeOutput(stdout);

    return { stories };
  }

  runInteractive(options: InteractiveRunOptions): PtyHandle {
    const pidRegistry = this.getPidRegistry(options.workdir);
    return runInteractiveMode(this.binary, options, pidRegistry);
  }
}
