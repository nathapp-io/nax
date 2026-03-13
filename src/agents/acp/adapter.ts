/**
 * ACP Agent Adapter — implements AgentAdapter interface via ACP session protocol.
 *
 * Session mode (run, plan) creates an ACP client session, sends a prompt, and
 * maps the response to AgentResult. One-shot mode (complete) uses a lightweight
 * single-turn session. The spawn-based _runOnce() is retained for backward
 * compatibility.
 *
 * See: docs/specs/acp-agent-adapter.md
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
import { parseAcpxJsonOutput, streamJsonRpcEvents } from "./parser";
import type { AcpxTokenUsage } from "./parser";
import type { AgentRegistryEntry } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AGENT_OUTPUT_CHARS = 5000;
const MAX_AGENT_STDERR_CHARS = 1000;
const SIGKILL_GRACE_PERIOD_MS = 5000;
const ACPX_WATCHDOG_BUFFER_MS = 30_000;
const STDOUT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Agent registry
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

// ─────────────────────────────────────────────────────────────────────────────
// ACP session interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface AcpSessionResponse {
  messages: Array<{ role: string; content: string }>;
  stopReason: string;
  cumulative_token_usage?: { input_tokens: number; output_tokens: number };
}

export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

export interface AcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession>;
  /** Resume an existing named session. Returns null if the session is not found. */
  loadSession?(sessionName: string): Promise<AcpSession | null>;
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _acpAdapterDeps = {
  which(name: string): string | null {
    return Bun.which(name);
  },

  async sleep(ms: number): Promise<void> {
    await Bun.sleep(ms);
  },

  /**
   * Create an ACP client for the given agent name.
   * Override in tests via: _acpAdapterDeps.createClient = mock(...)
   */
  createClient(_agentName: string): AcpClient {
    throw new Error(
      "[acp-adapter] createClient not configured. Use _acpAdapterDeps.createClient in tests or provide an acpx AcpClient factory.",
    );
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
    lower.includes("rate limit exceeded") ||
    lower.includes("rate limit reached") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("too many requests") ||
    /\b(http|status|error|code)[:\s]+429\b/.test(lower) ||
    /\bstatus[:\s]+429\b/.test(lower)
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

  if (options?.modelDef?.env) Object.assign(allowed, options.modelDef.env);
  if (options?.env) Object.assign(allowed, options.env);

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

  if (opts.skipPermissions) cmd.push("--approve-all");
  if (opts.format) cmd.push("--format", opts.format);
  if (opts.jsonStrict) cmd.push("--json-strict");
  if (opts.model) cmd.push("--model", opts.model);
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) cmd.push("--timeout", String(opts.timeoutSeconds));

  cmd.push(opts.agentName);
  cmd.push("exec");

  return cmd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session mode helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic ACP session name from feature and story identifiers.
 * Used to correlate plan() and run() calls for session continuity.
 */
export function buildSessionName(featureName?: string, storyId?: string): string {
  const parts = ["nax"];
  if (featureName) parts.push(featureName.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  if (storyId) parts.push(storyId.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  return parts.join("-");
}

/**
 * Ensure an ACP session exists via CLI (sessions ensure command).
 * Spawns: acpx claude sessions ensure --name <sessionName>
 * Returns the session name (deterministic from feature/story).
 */
export async function ensureAcpSession(sessionName?: string): Promise<string> {
  const name = sessionName ?? buildSessionName();
  const cmd = ["acpx", "claude", "sessions", "ensure", "--name", name];

  getSafeLogger()?.debug("acp-adapter", `Ensuring ACP session: ${name}`);

  const proc = _acpAdapterDeps.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`[acp-adapter] ensureAcpSession failed: ${stderr || `exit code ${exitCode}`}`);
  }

  return name;
}

/**
 * Send a prompt to the session via CLI (prompt command with -s flag).
 * Spawns: acpx --cwd <cwd> --approve-all --format json --model <model> --timeout <secs> claude prompt -s <sessionName> --file -
 * with prompt piped via stdin. Returns parsed response or null on timeout.
 */
export async function runSessionPrompt(
  sessionName: string,
  prompt: string,
  workdir: string,
  model: string,
  timeoutSeconds: number,
): Promise<AcpSessionResponse | null> {
  const cmd = [
    "acpx",
    "--cwd",
    workdir,
    "--approve-all",
    "--format",
    "json",
    "--model",
    model,
    "--timeout",
    String(timeoutSeconds),
    "claude",
    "prompt",
    "-s",
    sessionName,
    "--file",
    "-",
  ];

  getSafeLogger()?.debug("acp-adapter", `Sending prompt to ACP session: ${sessionName}`);

  const proc = _acpAdapterDeps.spawn(cmd, {
    cwd: workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  const timeoutMs = timeoutSeconds * 1000;
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }));
  const exitPromise = proc.exited.then(() => ({ kind: "exited" as const }));

  const winner = await Promise.race([exitPromise, timeoutPromise]);

  if (winner.kind === "timeout") {
    proc.kill();
    return null;
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  try {
    const parsed = parseAcpxJsonOutput(stdout);
    // Convert parsed output to AcpSessionResponse format
    return {
      messages: [{ role: "assistant", content: parsed.text || "" }],
      stopReason: "end_turn",
      cumulative_token_usage: parsed.tokenUsage,
    };
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to parse session prompt response", { stderr });
    throw err;
  }
}

/**
 * Close an ACP session via CLI (sessions close command).
 * Spawns: acpx claude sessions close <sessionName>
 */
export async function closeAcpSession(sessionName: string): Promise<void> {
  const cmd = ["acpx", "claude", "sessions", "close", sessionName];

  getSafeLogger()?.debug("acp-adapter", `Closing ACP session: ${sessionName}`);

  const proc = _acpAdapterDeps.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    getSafeLogger()?.warn("acp-adapter", "Failed to close session", { sessionName, stderr });
  }
}

/**
 * Extract a question from agent output text, if present.
 * Follows the spec: split into sentences, find last question, or check for markers.
 */
function extractQuestion(output: string): string | null {
  const text = output.trim();
  if (!text) return null;

  // Split into sentences and find question sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  const questionSentences = sentences.filter((s) => s.trim().endsWith("?"));
  if (questionSentences.length > 0) {
    const q = questionSentences[questionSentences.length - 1].trim();
    if (q.length > 10) return q;
  }

  // Check for explicit question markers
  const lower = text.toLowerCase();
  const markers = [
    "please confirm",
    "please specify",
    "please provide",
    "which would you",
    "should i ",
    "do you want",
    "can you clarify",
  ];
  for (const marker of markers) {
    if (lower.includes(marker)) {
      return text.slice(-200).trim();
    }
  }

  return null;
}

/**
 * Extract combined assistant output text from a session response.
 */
function extractOutput(response: AcpSessionResponse | null): string {
  if (!response) return "";
  return response.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n")
    .trim();
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
    const path = _acpAdapterDeps.which(this.binary);
    return path !== null;
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

  buildAllowedEnv(options?: AgentRunOptions): Record<string, string | undefined> {
    return buildAllowedEnv({ env: options?.env, modelDef: options?.modelDef });
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    getSafeLogger()?.debug("acp-adapter", `Starting run for ${this.name}`, {
      model: options.modelDef.model,
      workdir: options.workdir,
    });

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const result = await this._runSessionMode(options, startTime);
        if (!result.success) {
          getSafeLogger()?.warn("acp-adapter", `Run failed for ${this.name}`, { exitCode: result.exitCode });
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        const shouldRetry = (isRateLimitError(error) || isSpawnError(error)) && attempt < MAX_RATE_LIMIT_RETRIES - 1;
        if (!shouldRetry) break;

        const backoffMs = 2 ** (attempt + 1) * 1000;
        getSafeLogger()?.warn("acp-adapter", "Retrying after error", {
          reason: isRateLimitError(error) ? "rate-limit" : "spawn-error",
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

  private async _runSessionMode(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
    const sessionName = options.acpSessionName ?? buildSessionName(options.featureName, options.storyId);
    let response: AcpSessionResponse | null = null;
    let timedOut = false;
    let runError: Error | undefined;
    const totalTokenUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      // Ensure session exists
      const session = await ensureAcpSession(sessionName);

      // Multi-turn loop with interactionBridge support
      let currentPrompt = options.prompt;
      let turnCount = 0;
      const MAX_TURNS = options.interactionBridge ? 10 : 1;

      while (turnCount < MAX_TURNS) {
        turnCount++;
        getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

        // Send prompt to session
        response = await runSessionPrompt(
          session,
          currentPrompt,
          options.workdir,
          options.modelDef.model,
          options.timeoutSeconds,
        );

        if (!response) {
          timedOut = true;
          break;
        }

        // Accumulate token usage
        if (response.cumulative_token_usage) {
          totalTokenUsage.input_tokens = response.cumulative_token_usage.input_tokens;
          totalTokenUsage.output_tokens = response.cumulative_token_usage.output_tokens;
        }

        // Check if agent asked a question
        const outputText = extractOutput(response);
        const question = extractQuestion(outputText);

        if (!question || !options.interactionBridge) {
          // No question or no bridge — end session
          break;
        }

        // Answer the question via interaction bridge
        getSafeLogger()?.debug("acp-adapter", "Agent asked question, routing to interactionBridge", { question });

        let answer: string;
        try {
          answer = await options.interactionBridge.onQuestionDetected(question);
        } catch (err) {
          getSafeLogger()?.warn("acp-adapter", "InteractionBridge failed to answer question", { error: String(err) });
          break;
        }

        // Next turn: send the answer as the prompt
        currentPrompt = answer;
      }

      if (turnCount >= MAX_TURNS) {
        getSafeLogger()?.warn("acp-adapter", "Reached max turns limit", { sessionName, maxTurns: MAX_TURNS });
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      // Close session
      try {
        await closeAcpSession(sessionName);
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "Failed to close session in finally", { error: String(err) });
      }
    }

    if (runError) throw runError;

    const durationMs = Date.now() - startTime;

    if (timedOut) {
      return {
        success: false,
        exitCode: 124,
        output: `Session timed out after ${options.timeoutSeconds}s`,
        rateLimited: false,
        durationMs,
        estimatedCost: 0,
      };
    }

    const success = response?.stopReason === "end_turn";
    const output = extractOutput(response);
    const estimatedCost = estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model);

    return {
      success,
      exitCode: success ? 0 : 1,
      output: output.slice(-MAX_AGENT_OUTPUT_CHARS),
      rateLimited: false,
      durationMs,
      estimatedCost,
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

    const proc = _acpAdapterDeps.spawn([...cmd, "--file", "-"], {
      cwd: options.workdir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildAllowedEnv(options),
    });

    if (pidRegistry) {
      await pidRegistry.register(proc.pid);
      getSafeLogger()?.debug("acp-adapter", `Registered PID ${proc.pid} for ${this.name}`);
    }

    proc.stdin.write(options.prompt);
    proc.stdin.end();

    let parsed: { text: string; tokenUsage?: AcpxTokenUsage };
    let stderr = "";
    let exitCode = 0;
    let stdout = "";
    let timedOut = false;

    const watchdogMs = options.timeoutSeconds * 1000 + ACPX_WATCHDOG_BUFFER_MS;

    try {
      if (hasBridge) {
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
        const timeoutResult = await withProcessTimeout(proc, watchdogMs, {
          graceMs: SIGKILL_GRACE_PERIOD_MS,
          onTimeout: () => {
            timedOut = true;
          },
        });
        exitCode = timeoutResult.exitCode;
        timedOut = timeoutResult.timedOut;

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
      if (pidRegistry) {
        await pidRegistry.unregister(proc.pid);
        getSafeLogger()?.debug("acp-adapter", `Unregistered PID ${proc.pid} for ${this.name}`, { exitCode });
      }
    }

    const durationMs = Date.now() - startTime;
    const actualExitCode = timedOut ? 124 : exitCode;
    const fullOutput = stdout + stderr + (parsed.text ?? "");
    const rateLimited = exitCode !== 0 ? detectRateLimit(fullOutput) : false;

    let estimatedCost: number;
    if (parsed.tokenUsage) {
      estimatedCost = estimateCostFromTokenUsage(parsed.tokenUsage, options.modelDef.model);
    } else {
      const regexEstimate = estimateCostFromOutput(options.modelTier, fullOutput);
      if (regexEstimate) {
        estimatedCost = regexEstimate.cost;
      } else {
        estimatedCost = estimateCostByDuration(options.modelTier, durationMs).cost * 1.5;
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
    const startTime = Date.now();
    const modelDef = _options?.model
      ? { provider: "anthropic", model: _options.model }
      : { provider: "anthropic", model: "default" };
    const result = await this._runOnce(
      {
        prompt,
        workdir: process.cwd(),
        modelTier: "balanced",
        modelDef,
        timeoutSeconds: 60,
        dangerouslySkipPermissions: true,
      },
      startTime,
    );

    if (!result.success) {
      throw new CompleteError(`complete() failed: ${result.output}`, result.exitCode);
    }

    const text = result.output.trim();
    if (!text) {
      throw new CompleteError("complete() returned empty output");
    }

    return text;
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    if (options.interactive) {
      throw new Error("[acp-adapter] plan() interactive mode is not yet supported via ACP");
    }

    // Create or ensure ACP session for plan→run continuity
    const sessionName = await ensureAcpSession(buildSessionName(options.featureName, options.storyId));

    // Notify caller of session name
    if (options.onAcpSessionCreated) {
      try {
        await options.onAcpSessionCreated(sessionName);
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "Failed to invoke onAcpSessionCreated callback", { error: String(err) });
      }
    }

    const modelDef = options.modelDef ?? { provider: "anthropic", model: "default" };
    const result = await this.run({
      prompt: options.prompt,
      workdir: options.workdir,
      modelTier: options.modelTier ?? "balanced",
      modelDef,
      timeoutSeconds: 600,
      dangerouslySkipPermissions: true,
      interactionBridge: options.interactionBridge,
      acpSessionName: sessionName,
      featureName: options.featureName,
      storyId: options.storyId,
    });

    if (!result.success) {
      throw new Error(`[acp-adapter] plan() failed: ${result.output}`);
    }

    const specContent = result.output.trim();
    if (!specContent) {
      throw new Error("[acp-adapter] plan() returned empty spec content");
    }

    return { specContent };
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const model = options.modelDef?.model;
    const prompt = buildDecomposePrompt(options);

    let output: string;
    try {
      output = await this.complete(prompt, { model, jsonMode: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[acp-adapter] decompose() failed: ${msg}`, { cause: err });
    }

    let stories: ReturnType<typeof parseDecomposeOutput>;
    try {
      stories = parseDecomposeOutput(output);
    } catch (err) {
      throw new Error(`[acp-adapter] decompose() failed to parse stories: ${(err as Error).message}`, { cause: err });
    }

    return { stories };
  }
}
