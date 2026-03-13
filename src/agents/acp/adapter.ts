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
}): string[] {
  const cmd = ["acpx", "--approve-all"];

  if (opts.format) {
    cmd.push("--format", opts.format);
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
    const cmd = buildAcpxExecCommand({
      agentName: this.name,
      model: options.modelDef.model,
      workdir: options.workdir,
      timeoutSeconds: options.timeoutSeconds,
      format: "json",
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

    // Read stdout + stderr concurrently with process exit (avoid deadlock on >64KB)
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const durationMs = Date.now() - startTime;
    const parsed = parseAcpxJsonOutput(stdout);

    if (exitCode !== 0 && !parsed.text) {
      const errorMsg = stderr.trim() || parsed.error || `acpx exec failed with exit code ${exitCode}`;
      return {
        success: false,
        exitCode,
        output: errorMsg,
        rateLimited: isRateLimitError(new Error(errorMsg)),
        durationMs,
        estimatedCost: 0,
      };
    }

    const estimatedCost = parsed.tokenUsage ? estimateCostFromTokenUsage(parsed.tokenUsage, options.modelDef.model) : 0;

    return {
      success: exitCode === 0,
      exitCode,
      output: parsed.text || stdout.trim(),
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
