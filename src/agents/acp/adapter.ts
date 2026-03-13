/**
 * ACP Agent Adapter — implements AgentAdapter interface via acpx CLI
 *
 * Uses `acpx` as a headless CLI client for the Agent Client Protocol (ACP).
 * All interactions go through `acpx exec` (one-shot) for simplicity.
 * Agent NDJSON output is parsed for structured results and cost tracking.
 *
 * See: https://github.com/openclaw/acpx
 */

import { withProcessTimeout } from "../../execution/timeout-handler";
import { getSafeLogger } from "../../logger";
import { buildDecomposePrompt, parseDecomposeOutput } from "../claude-decompose";
import { estimateCostByDuration, estimateCostFromOutput } from "../cost";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "../types";
import { CompleteError } from "../types";
import { estimateCostFromTokenUsage } from "./cost";
import type { AgentRegistryEntry } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum characters to capture from agent stdout. */
const MAX_AGENT_OUTPUT_CHARS = 5000;
/** Maximum characters to capture from agent stderr. */
const MAX_AGENT_STDERR_CHARS = 1000;
/** Grace period in ms between SIGTERM and SIGKILL on timeout. */
const SIGKILL_GRACE_PERIOD_MS = 5000;
/** Buffer added to timeoutSeconds for the outer acpx watchdog. */
const ACPX_WATCHDOG_BUFFER_MS = 30_000;
/** Fallback timeout for stdout drain after process exits. */
const STDOUT_DRAIN_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Agent registry — maps nax agent names to acpx agent identifiers
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_REGISTRY: Record<string, AgentRegistryEntry> = {
  claude: {
    binary: "claude",
    displayName: "Claude Code (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
  },
  codex: {
    binary: "codex",
    displayName: "OpenAI Codex (ACP)",
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 128_000,
  },
  gemini: {
    binary: "gemini",
    displayName: "Gemini CLI (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
  },
};

const DEFAULT_ENTRY: AgentRegistryEntry = {
  binary: "claude",
  displayName: "ACP Agent",
  supportedTiers: ["balanced"],
  maxContextTokens: 128_000,
};

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies — follows the _deps pattern for testability
// ─────────────────────────────────────────────────────────────────────────────

export const _acpAdapterDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },

  async sleep(ms: number): Promise<void> {
    await Bun.sleep(ms);
  },

  spawn(
    cmd: string[],
    opts: {
      cwd?: string;
      stdin?: "pipe" | "inherit";
      stdout: "pipe";
      stderr: "pipe";
      timeout?: number;
      env?: Record<string, string | undefined>;
    },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    /** Bun FileSink — use .write() + .end(), NOT getWriter() */
    stdin: { write(data: string | Uint8Array): number; end(): void; flush(): void };
    exited: Promise<number>;
    pid: number;
    kill(signal?: number): void;
  } {
    return Bun.spawn(cmd, opts) as unknown as ReturnType<typeof _acpAdapterDeps.spawn>;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveRegistryEntry(agentName: string): AgentRegistryEntry {
  return AGENT_REGISTRY[agentName] ?? DEFAULT_ENTRY;
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("429");
}

function detectRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  );
}

function isSpawnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("spawn") || err.message.includes("ENOENT");
}

/**
 * Build allowed environment variables for spawned acpx processes.
 * SEC-4: Only pass essential env vars to prevent leaking sensitive data.
 */
export function buildAllowedEnv(options?: {
  env?: Record<string, string>;
  modelDef?: { env?: Record<string, string | undefined> };
}): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};

  const essentialVars = ["PATH", "HOME", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];
  for (const varName of essentialVars) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  const apiKeyVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_API_KEY"];
  for (const varName of apiKeyVars) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  const allowedPrefixes = ["CLAUDE_", "NAX_", "CLAW_", "TURBO_", "ACPX_", "CODEX_", "GEMINI_"];
  for (const [key, value] of Object.entries(process.env)) {
    if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
      allowed[key] = value;
    }
  }

  // modelDef.env overrides (e.g., per-model API key or base URL)
  if (options?.modelDef?.env) {
    Object.assign(allowed, options.modelDef.env);
  }

  // options.env overrides (caller-supplied, highest priority)
  if (options?.env) {
    Object.assign(allowed, options.env);
  }

  return allowed;
}

/**
 * Build the acpx CLI command for exec (one-shot) mode.
 */
function buildAcpxExecCommand(opts: {
  agentName: string;
  model?: string;
  workdir?: string;
  timeoutSeconds?: number;
  format?: "text" | "json" | "quiet";
  jsonStrict?: boolean;
  skipPermissions?: boolean;
}): string[] {
  const cmd = ["acpx"];

  // Only add --approve-all if explicitly true (default false for ACP)
  if (opts.skipPermissions) {
    cmd.push("--approve-all");
  }

  if (opts.format) {
    cmd.push("--format", opts.format);
  }

  if (opts.jsonStrict) {
    cmd.push("--json-strict");
  }

  if (opts.model) {
    cmd.push("--model", opts.model);
  }

  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
    cmd.push("--timeout", String(opts.timeoutSeconds));
  }

  // Agent name (resolved by acpx's built-in registry)
  cmd.push(opts.agentName);

  // exec subcommand for one-shot
  cmd.push("exec");

  return cmd;
}

/** Token usage from acpx NDJSON events */
interface AcpxTokenUsage {
  input_tokens: number;
  output_tokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC event parsing for interaction bridge
// ─────────────────────────────────────────────────────────────────────────────

/** JSON-RPC message from acpx --format json --json-strict */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  method?: string;
  params?: {
    sessionId: string;
    update?: {
      sessionUpdate: string;
      content?: {
        type: string;
        text?: string;
      };
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
    };
  };
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Stream stdout line-by-line, parse JSON-RPC, detect questions, call bridge.
 */
async function streamJsonRpcEvents(
  stdout: ReadableStream<Uint8Array>,
  bridge: AgentRunOptions["interactionBridge"],
  sessionId: string,
): Promise<{ text: string; tokenUsage?: AcpxTokenUsage }> {
  let accumulatedText = "";
  let tokenUsage: AcpxTokenUsage | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          // Not JSON - skip
          continue;
        }

        // Handle session/update notifications
        if (msg.method === "session/update" && msg.params?.update) {
          const update = msg.params.update;

          // Accumulate assistant text chunks
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            update.content.text
          ) {
            accumulatedText += update.content.text;

            // Check for question via bridge if provided
            if (bridge?.detectQuestion && bridge.onQuestionDetected) {
              const isQuestion = await bridge.detectQuestion(accumulatedText);
              if (isQuestion) {
                const response = await bridge.onQuestionDetected(accumulatedText);
                // In a full implementation, we'd inject this response back into the session
                // For now, we just capture the interaction
                accumulatedText += `\n\n[Human response: ${response}]`;
              }
            }
          }

          // Capture token usage
          if (update.sessionUpdate === "usage_update" && update.used !== undefined && update.size !== undefined) {
            // usage_update gives us used/total, not input/output breakdown
            // Estimate: assume 30% input, 70% output for running prompts
            const total = update.used;
            tokenUsage = {
              input_tokens: Math.floor(total * 0.3),
              output_tokens: Math.floor(total * 0.7),
            };
          }

          // Capture final cost
          if (update.sessionUpdate === "usage_update" && update.cost) {
            // Cost is already calculated by the agent
          }
        }

        // Handle result (final response)
        if (msg.result) {
          const result = msg.result as Record<string, unknown>;
          if (typeof result === "string") {
            accumulatedText += result;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: accumulatedText.trim(), tokenUsage };
}

/**
 * Parse acpx NDJSON output for assistant text and token usage.
 *
 * acpx --format json emits NDJSON lines. We look for:
 * - Lines with assistant content (text blocks)
 * - Lines with cumulative_token_usage
 * - Lines with error info
 */
function parseAcpxJsonOutput(rawOutput: string): {
  text: string;
  tokenUsage?: AcpxTokenUsage;
  stopReason?: string;
  error?: string;
} {
  const lines = rawOutput.split("\n").filter((l) => l.trim());
  let text = "";
  let tokenUsage: AcpxTokenUsage | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Extract assistant text from various event shapes
      if (event.content && typeof event.content === "string") {
        text += event.content;
      }
      if (event.text && typeof event.text === "string") {
        text += event.text;
      }
      if (event.result && typeof event.result === "string") {
        text = event.result;
      }

      // Token usage
      if (event.cumulative_token_usage) {
        tokenUsage = event.cumulative_token_usage;
      }
      if (event.usage) {
        tokenUsage = {
          input_tokens: event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0,
          output_tokens: event.usage.output_tokens ?? event.usage.completion_tokens ?? 0,
        };
      }

      // Stop reason
      if (event.stopReason) stopReason = event.stopReason;
      if (event.stop_reason) stopReason = event.stop_reason;

      // Error
      if (event.error) {
        error = typeof event.error === "string" ? event.error : (event.error.message ?? JSON.stringify(event.error));
      }
    } catch {
      // Not JSON — treat as plain text output (--format text fallback)
      if (!text) text = line;
    }
  }

  return { text: text.trim(), tokenUsage, stopReason, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class AcpAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly binary: string;
  readonly capabilities: AgentCapabilities;

  constructor(agentName: string) {
    const entry = resolveRegistryEntry(agentName);
    this.name = agentName;
    this.displayName = entry.displayName;
    this.binary = entry.binary;
    this.capabilities = {
      supportedTiers: entry.supportedTiers,
      maxContextTokens: entry.maxContextTokens,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "review", "refactor"]),
    };
  }

  async isInstalled(): Promise<boolean> {
    // Check for acpx binary (the ACP CLI), not the agent binary directly
    const acpxPath = _acpAdapterDeps.which("acpx");
    return acpxPath !== null;
  }

  buildCommand(options: AgentRunOptions): string[] {
    return buildAcpxExecCommand({
      agentName: this.name,
      model: options.modelDef.model,
      workdir: options.workdir,
      timeoutSeconds: options.timeoutSeconds,
      format: "json",
      skipPermissions: options.dangerouslySkipPermissions,
    });
  }

  /**
   * Build filtered environment variables for spawned acpx processes.
   * SEC-4: Only passes essential and API key vars, plus options.env overrides.
   */
  buildAllowedEnv(options?: AgentRunOptions): Record<string, string | undefined> {
    return buildAllowedEnv({ env: options?.env, modelDef: options?.modelDef });
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    getSafeLogger()?.debug("acp-adapter", `Starting run for ${this.name}`, {
      model: options.modelDef.model,
      workdir: options.workdir,
      hasBridge: !!options.interactionBridge,
    });

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      if (attempt > 0) {
        getSafeLogger()?.debug("acp-adapter", `Retry attempt ${attempt + 1} for ${this.name}`);
        await _acpAdapterDeps.sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      try {
        const result = await this._runOnce(options, startTime);

        // Retry on rate limit (mirrors ClaudeCodeAdapter behaviour)
        if (result.rateLimited && attempt < MAX_RATE_LIMIT_RETRIES - 1) {
          const backoffMs = 2 ** (attempt + 1) * 1000;
          getSafeLogger()?.warn("acp-adapter", "Rate limited, retrying", {
            backoffSeconds: backoffMs / 1000,
            attempt: attempt + 1,
            maxRetries: MAX_RATE_LIMIT_RETRIES,
          });
          await _acpAdapterDeps.sleep(backoffMs);
          continue;
        }

        if (!result.success) {
          getSafeLogger()?.warn("acp-adapter", `Run failed for ${this.name}`, {
            exitCode: result.exitCode,
            output: result.output?.slice(0, 200),
            rateLimited: result.rateLimited,
          });
        } else {
          getSafeLogger()?.debug("acp-adapter", `Run succeeded for ${this.name}`, {
            cost: result.estimatedCost,
            durationMs: result.durationMs,
          });
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        getSafeLogger()?.error("acp-adapter", `Run error for ${this.name}: ${error.message}`, {
          attempt: attempt + 1,
          error: error.message,
        });

        const shouldRetry = isRateLimitError(error) || isSpawnError(error);
        if (!shouldRetry || attempt >= MAX_RATE_LIMIT_RETRIES - 1) break;

        const backoffMs = 2 ** (attempt + 1) * 1000;
        getSafeLogger()?.warn("acp-adapter", "Retrying after error", {
          reason: isSpawnError(error) ? "spawn-error" : "rate-limit",
          backoffSeconds: backoffMs / 1000,
          attempt: attempt + 1,
        });
        await _acpAdapterDeps.sleep(backoffMs);
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      success: false,
      exitCode: 1,
      output: lastError?.message ?? "Run failed",
      rateLimited: isRateLimitError(lastError),
      durationMs,
      estimatedCost: 0,
    };
  }

  private async _runOnce(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
    const hasBridge = !!options.interactionBridge;
    const pidRegistry = options.pidRegistry;
    const cmd = buildAcpxExecCommand({
      agentName: this.name,
      model: options.modelDef.model,
      workdir: options.workdir,
      timeoutSeconds: options.timeoutSeconds,
      format: "json",
      jsonStrict: hasBridge,
      skipPermissions: options.dangerouslySkipPermissions,
    });

    getSafeLogger()?.debug("acp-adapter", `Spawning acpx: ${cmd.join(" ")}`, { cwd: options.workdir });

    // Prompt is passed via stdin with --file - (supports arbitrarily long prompts)
    const proc = _acpAdapterDeps.spawn([...cmd, "--file", "-"], {
      cwd: options.workdir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildAllowedEnv(options),
    });

    // Register PID for crash recovery cleanup
    if (pidRegistry) {
      await pidRegistry.register(proc.pid);
      getSafeLogger()?.debug("acp-adapter", `Registered PID ${proc.pid} for ${this.name}`);
    }

    // Write prompt to stdin (Bun FileSink API)
    proc.stdin.write(options.prompt);
    proc.stdin.end();

    let parsed: { text: string; tokenUsage?: AcpxTokenUsage };
    let stderr = "";
    let exitCode = 0;
    let stdout = "";
    let timedOut = false;

    // Outer watchdog: timeoutSeconds covers the agent; add buffer for acpx overhead
    const watchdogMs = options.timeoutSeconds * 1000 + ACPX_WATCHDOG_BUFFER_MS;

    try {
      if (hasBridge) {
        // Stream JSON-RPC events for interaction bridge
        const sessionId = `session-${Date.now()}`;
        const streamPromise = streamJsonRpcEvents(proc.stdout, options.interactionBridge, sessionId);

        const timeoutResult = await withProcessTimeout(proc, watchdogMs, {
          graceMs: SIGKILL_GRACE_PERIOD_MS,
          onTimeout: () => {
            timedOut = true;
          },
        });
        exitCode = timeoutResult.exitCode;
        timedOut = timeoutResult.timedOut;

        parsed = await streamPromise;
        stderr = await new Response(proc.stderr).text();
      } else {
        // Non-streaming: collect all output at once; use watchdog for acpx hang protection
        const timeoutResult = await withProcessTimeout(proc, watchdogMs, {
          graceMs: SIGKILL_GRACE_PERIOD_MS,
          onTimeout: () => {
            timedOut = true;
          },
        });
        exitCode = timeoutResult.exitCode;
        timedOut = timeoutResult.timedOut;

        // Drain stdout/stderr with fallback timeout (safety net for pipe backpressure)
        let stdoutTimeoutId: ReturnType<typeof setTimeout> | undefined;
        let stderrTimeoutId: ReturnType<typeof setTimeout> | undefined;
        [stdout, stderr] = await Promise.all([
          Promise.race([
            new Response(proc.stdout).text(),
            new Promise<string>((resolve) => {
              stdoutTimeoutId = setTimeout(() => resolve(""), STDOUT_DRAIN_TIMEOUT_MS);
            }),
          ]).then((v) => {
            clearTimeout(stdoutTimeoutId);
            return v;
          }),
          Promise.race([
            new Response(proc.stderr).text(),
            new Promise<string>((resolve) => {
              stderrTimeoutId = setTimeout(() => resolve(""), STDOUT_DRAIN_TIMEOUT_MS);
            }),
          ]).then((v) => {
            clearTimeout(stderrTimeoutId);
            return v;
          }),
        ]);
        parsed = parseAcpxJsonOutput(stdout);
      }
    } finally {
      // Unregister PID on exit
      if (pidRegistry) {
        await pidRegistry.unregister(proc.pid);
        getSafeLogger()?.debug("acp-adapter", `Unregistered PID ${proc.pid} for ${this.name}`, { exitCode });
      }
    }

    const durationMs = Date.now() - startTime;

    // Map timeout to exit code 124 (matches POSIX timeout convention)
    const actualExitCode = timedOut ? 124 : exitCode;

    // Rate limit detection: scan both stdout and stderr
    const fullOutput = stdout + stderr + (parsed.text ?? "");
    const rateLimited = detectRateLimit(fullOutput);

    // Cost estimation: prefer token-based, fall back to duration-based
    let estimatedCost: number;
    if (parsed.tokenUsage) {
      estimatedCost = estimateCostFromTokenUsage(parsed.tokenUsage, options.modelDef.model);
    } else {
      // Try regex-based extraction from raw output
      const regexEstimate = estimateCostFromOutput(options.modelTier, fullOutput);
      if (regexEstimate) {
        estimatedCost = regexEstimate.cost;
        if (regexEstimate.confidence === "estimated") {
          getSafeLogger()?.warn("acp-adapter", "Cost estimation using regex parsing (estimated confidence)", {
            cost: estimatedCost,
          });
        }
      } else {
        // Duration-based fallback with 1.5x multiplier (matches claude adapter)
        const fallback = estimateCostByDuration(options.modelTier, durationMs);
        estimatedCost = fallback.cost * 1.5;
        getSafeLogger()?.warn("acp-adapter", "Cost estimation fallback (duration-based)", {
          modelTier: options.modelTier,
          cost: estimatedCost,
        });
      }
    }

    if (actualExitCode !== 0 && !parsed.text && !stderr) {
      const errorMsg = timedOut
        ? `acpx exec timed out after ${options.timeoutSeconds}s`
        : `acpx exec failed with exit code ${exitCode}`;
      return {
        success: false,
        exitCode: actualExitCode,
        output: errorMsg,
        rateLimited: detectRateLimit(errorMsg),
        durationMs,
        estimatedCost: 0,
        pid: proc.pid,
      };
    }

    const outputText = parsed.text || stdout.trim();

    return {
      success: exitCode === 0 && !timedOut,
      exitCode: actualExitCode,
      output: outputText.slice(-MAX_AGENT_OUTPUT_CHARS),
      stderr: stderr.slice(-MAX_AGENT_STDERR_CHARS) || undefined,
      rateLimited,
      durationMs,
      estimatedCost,
      pid: proc.pid,
    };
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const model = _options?.model;
    const cmd = buildAcpxExecCommand({
      agentName: this.name,
      model,
      format: "quiet", // quiet = final assistant text only
      skipPermissions: true, // complete() is fire-and-forget, always skip prompts
    });

    // Pass prompt via --file - (stdin)
    const proc = _acpAdapterDeps.spawn([...cmd, "--file", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildAllowedEnv(),
    });

    // Write prompt to stdin (Bun FileSink API)
    proc.stdin.write(prompt);
    proc.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const trimmed = stdout.trim();

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || trimmed || `acpx exec failed with exit code ${exitCode}`;
      throw new CompleteError(errorMsg, exitCode);
    }

    if (!trimmed) {
      throw new CompleteError("acpx exec returned empty output");
    }

    return trimmed;
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    const modelDef = options.modelDef ?? { provider: "anthropic", model: "default" };
    const result = await this.run({
      prompt: options.prompt,
      workdir: options.workdir,
      modelTier: options.modelTier ?? "balanced",
      modelDef,
      timeoutSeconds: 600, // planning can take a while
      dangerouslySkipPermissions: true,
      interactionBridge: options.interactionBridge,
    });

    if (!result.success) {
      throw new Error(`[acp-adapter] plan() failed: ${result.output}`);
    }

    return { specContent: result.output };
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const model = options.modelDef?.model;
    const prompt = buildDecomposePrompt(options);
    const output = await this.complete(prompt, { model, jsonMode: true });

    let stories: ReturnType<typeof parseDecomposeOutput>;
    try {
      stories = parseDecomposeOutput(output);
    } catch (err) {
      throw new Error(`[acp-adapter] decompose() failed to parse stories: ${(err as Error).message}`, { cause: err });
    }

    return { stories };
  }
}
