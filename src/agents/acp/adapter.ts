/**
 * ACP Agent Adapter — implements AgentAdapter interface via acpx CLI
 *
 * Uses `acpx` as a headless CLI client for the Agent Client Protocol (ACP).
 * All interactions go through `acpx exec` (one-shot) for simplicity.
 * Agent NDJSON output is parsed for structured results and cost tracking.
 *
 * See: https://github.com/openclaw/acpx
 */

import { buildDecomposePrompt, parseDecomposeOutput } from "../claude-decompose";
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
    opts: { cwd?: string; stdin?: "pipe" | "inherit"; stdout: "pipe"; stderr: "pipe"; timeout?: number },
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
}): string[] {
  const cmd = ["acpx", "--approve-all"];

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
    });
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      if (attempt > 0) {
        await _acpAdapterDeps.sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      try {
        return await this._runOnce(options, startTime);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        if (!isRateLimitError(error)) break;
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
    const cmd = buildAcpxExecCommand({
      agentName: this.name,
      model: options.modelDef.model,
      workdir: options.workdir,
      timeoutSeconds: options.timeoutSeconds,
      // Use json-strict when bridge is enabled for structured JSON-RPC events
      format: hasBridge ? "json" : "json",
      jsonStrict: hasBridge,
    });

    // Prompt is passed via stdin with --file - (supports arbitrarily long prompts)
    const proc = _acpAdapterDeps.spawn([...cmd, "--file", "-"], {
      cwd: options.workdir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write prompt to stdin (Bun FileSink API)
    proc.stdin.write(options.prompt);
    proc.stdin.end();

    let parsed: { text: string; tokenUsage?: AcpxTokenUsage };
    let stderr = "";

    if (hasBridge) {
      // Stream JSON-RPC events for interaction bridge
      const sessionId = `session-${Date.now()}`;
      parsed = await streamJsonRpcEvents(proc.stdout, options.interactionBridge, sessionId);
      stderr = await new Response(proc.stderr).text();
    } else {
      // Non-streaming: collect all output at once
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      // Handle early exit
      if (exitCode !== 0 && !hasBridge) {
        stderr = await new Response(proc.stderr).text();
      }
      parsed = parseAcpxJsonOutput(hasBridge ? "" : await new Response(proc.stdout).text());
    }

    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      hasBridge ? Promise.resolve("") : new Response(proc.stdout).text(),
    ]);

    const durationMs = Date.now() - startTime;

    // If not using bridge, parse normally
    if (!hasBridge) {
      parsed = parseAcpxJsonOutput(stdout);
    }

    if (exitCode !== 0 && !parsed.text && !stderr) {
      const errorMsg = `acpx exec failed with exit code ${exitCode}`;
      return {
        success: false,
        exitCode,
        output: errorMsg,
        rateLimited: isRateLimitError(new Error(errorMsg)),
        durationMs,
        estimatedCost: 0,
      };
    }

    const errorMsg = stderr.trim() || parsed.text?.includes("error") ? parsed.text : "";
    const estimatedCost = parsed.tokenUsage ? estimateCostFromTokenUsage(parsed.tokenUsage, options.modelDef.model) : 0;

    return {
      success: exitCode === 0,
      exitCode,
      output: parsed.text || stdout.trim() || errorMsg,
      rateLimited: false,
      durationMs,
      estimatedCost,
    };
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const model = _options?.model;
    const cmd = buildAcpxExecCommand({
      agentName: this.name,
      model,
      format: "quiet", // quiet = final assistant text only
    });

    // Pass prompt via --file - (stdin)
    const proc = _acpAdapterDeps.spawn([...cmd, "--file", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
    const model = options.modelDef?.model;
    const specContent = await this.complete(options.prompt, { model });
    return { specContent };
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
