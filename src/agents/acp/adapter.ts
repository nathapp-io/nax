/**
 * ACP Agent Adapter — implements AgentAdapter interface via ACP session protocol.
 *
 * All methods use the createClient injectable as the transport layer.
 * Session lifecycle (naming, persistence, ensure/close) is handled by
 * thin wrapper functions on top of AcpClient/AcpSession.
 *
 * Session naming: nax-<gitRootHash8>-<feature>-<story>[-<role>]
 * Persistence: nax/features/<feature>/acp-sessions.json sidecar
 *
 * See: docs/specs/acp-session-mode.md
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getSafeLogger } from "../../logger";
import { buildDecomposePrompt, parseDecomposeOutput } from "../claude-decompose";
import { createSpawnAcpClient } from "./spawn-client";

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

const MAX_AGENT_OUTPUT_CHARS = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;
const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for human to respond

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
   * Create an ACP client for the given command string.
   * Default: spawn-based client (shells out to acpx CLI).
   * Override in tests via: _acpAdapterDeps.createClient = mock(...)
   */
  createClient(cmdStr: string, cwd?: string, timeoutSeconds?: number): AcpClient {
    return createSpawnAcpClient(cmdStr, cwd, timeoutSeconds);
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

// ─────────────────────────────────────────────────────────────────────────────
// Session naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic ACP session name.
 *
 * Format: nax-<gitRootHash8>-<featureName>-<storyId>[-<sessionRole>]
 *
 * The workdir hash (first 8 chars of SHA-256) prevents cross-repo and
 * cross-worktree session name collisions. Each git worktree has a distinct
 * root path, so different worktrees of the same repo get different hashes.
 */
export function buildSessionName(
  workdir: string,
  featureName?: string,
  storyId?: string,
  sessionRole?: string,
): string {
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  const sanitize = (s: string) =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "");

  const parts = ["nax", hash];
  if (featureName) parts.push(sanitize(featureName));
  if (storyId) parts.push(sanitize(storyId));
  if (sessionRole) parts.push(sanitize(sessionRole));
  return parts.join("-");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle functions (createClient-backed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure an ACP session exists: try to resume via loadSession, fall back to
 * createSession. Returns the AcpSession ready for prompt() calls.
 */
export async function ensureAcpSession(
  client: AcpClient,
  sessionName: string,
  agentName: string,
  permissionMode: string,
): Promise<AcpSession> {
  // Try to resume existing session first
  if (client.loadSession) {
    try {
      const existing = await client.loadSession(sessionName);
      if (existing) {
        getSafeLogger()?.debug("acp-adapter", `Resumed existing session: ${sessionName}`);
        return existing;
      }
    } catch {
      // loadSession failed — fall through to createSession
    }
  }

  // Create a new named session
  getSafeLogger()?.debug("acp-adapter", `Creating new session: ${sessionName}`);
  return client.createSession({ agentName, permissionMode, sessionName });
}

/**
 * Send a prompt turn to the session with timeout.
 * If the timeout fires, attempts to cancel the active prompt and returns timedOut=true.
 */
export async function runSessionPrompt(
  session: AcpSession,
  prompt: string,
  timeoutMs: number,
): Promise<{ response: AcpSessionResponse | null; timedOut: boolean }> {
  const promptPromise = session.prompt(prompt);
  const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));

  const winner = await Promise.race([promptPromise, timeoutPromise]);

  if (winner === "timeout") {
    try {
      await session.cancelActivePrompt();
    } catch {
      await session.close().catch(() => {});
    }
    return { response: null, timedOut: true };
  }

  return { response: winner as AcpSessionResponse, timedOut: false };
}

/**
 * Close an ACP session — best-effort, swallows errors.
 */
export async function closeAcpSession(session: AcpSession): Promise<void> {
  try {
    await session.close();
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to close session", { error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACP session sidecar persistence
// ─────────────────────────────────────────────────────────────────────────────

/** Path to the ACP sessions sidecar file for a feature. */
function acpSessionsPath(workdir: string, featureName: string): string {
  return join(workdir, "nax", "features", featureName, "acp-sessions.json");
}

/** Persist a session name to the sidecar file. Best-effort — errors are swallowed. */
export async function saveAcpSession(
  workdir: string,
  featureName: string,
  storyId: string,
  sessionName: string,
): Promise<void> {
  try {
    const path = acpSessionsPath(workdir, featureName);
    let data: Record<string, string> = {};
    try {
      const existing = await Bun.file(path).text();
      data = JSON.parse(existing);
    } catch {
      // File doesn't exist yet — start fresh
    }
    data[storyId] = sessionName;
    await Bun.write(path, JSON.stringify(data, null, 2));
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to save session to sidecar", { error: String(err) });
  }
}

/** Clear a session name from the sidecar file. Best-effort — errors are swallowed. */
export async function clearAcpSession(workdir: string, featureName: string, storyId: string): Promise<void> {
  try {
    const path = acpSessionsPath(workdir, featureName);
    let data: Record<string, string> = {};
    try {
      const existing = await Bun.file(path).text();
      data = JSON.parse(existing);
    } catch {
      return; // File doesn't exist — nothing to clear
    }
    delete data[storyId];
    await Bun.write(path, JSON.stringify(data, null, 2));
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to clear session from sidecar", { error: String(err) });
  }
}

/** Read a persisted session name from the sidecar file. Returns null if not found. */
export async function readAcpSession(workdir: string, featureName: string, storyId: string): Promise<string | null> {
  try {
    const path = acpSessionsPath(workdir, featureName);
    const existing = await Bun.file(path).text();
    const data: Record<string, string> = JSON.parse(existing);
    return data[storyId] ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Extract a question from agent output text, if present.
 */
function extractQuestion(output: string): string | null {
  const text = output.trim();
  if (!text) return null;

  const sentences = text.split(/(?<=[.!?])\s+/);
  const questionSentences = sentences.filter((s) => s.trim().endsWith("?"));
  if (questionSentences.length > 0) {
    const q = questionSentences[questionSentences.length - 1].trim();
    if (q.length > 10) return q;
  }

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

  buildCommand(_options: AgentRunOptions): string[] {
    // ACP adapter uses createClient, not direct CLI invocation.
    // Return a descriptive command for logging/display purposes only.
    return ["acpx", this.name, "session"];
  }

  buildAllowedEnv(_options?: AgentRunOptions): Record<string, string | undefined> {
    // createClient manages its own env; no separate env building needed.
    return {};
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    getSafeLogger()?.debug("acp-adapter", `Starting run for ${this.name}`, {
      model: options.modelDef.model,
      workdir: options.workdir,
      featureName: options.featureName,
      storyId: options.storyId,
      sessionRole: options.sessionRole,
    });

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const result = await this._runWithClient(options, startTime);
        if (!result.success) {
          getSafeLogger()?.warn("acp-adapter", `Run failed for ${this.name}`, { exitCode: result.exitCode });
        }
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        const shouldRetry = isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES - 1;
        if (!shouldRetry) break;

        const backoffMs = 2 ** (attempt + 1) * 1000;
        getSafeLogger()?.warn("acp-adapter", "Retrying after rate limit", {
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

  private async _runWithClient(options: AgentRunOptions, startTime: number): Promise<AgentResult> {
    const cmdStr = `acpx --model ${options.modelDef.model} ${this.name}`;
    const client = _acpAdapterDeps.createClient(cmdStr, options.workdir, options.timeoutSeconds);
    await client.start();

    // 1. Resolve session name: explicit > sidecar > derived
    let sessionName = options.acpSessionName;
    if (!sessionName && options.featureName && options.storyId) {
      sessionName = (await readAcpSession(options.workdir, options.featureName, options.storyId)) ?? undefined;
    }
    sessionName ??= buildSessionName(options.workdir, options.featureName, options.storyId, options.sessionRole);

    // 2. Permission mode follows dangerouslySkipPermissions, default is "approve-reads". or should --deny-all be the default?
    const permissionMode = options.dangerouslySkipPermissions ? "approve-all" : "approve-reads";

    // 3. Ensure session (resume existing or create new)
    const session = await ensureAcpSession(client, sessionName, this.name, permissionMode);

    // 4. Persist for plan→run continuity
    if (options.featureName && options.storyId) {
      await saveAcpSession(options.workdir, options.featureName, options.storyId, sessionName);
    }

    let lastResponse: AcpSessionResponse | null = null;
    let timedOut = false;
    const totalTokenUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      // 5. Multi-turn loop
      let currentPrompt = options.prompt;
      let turnCount = 0;
      const MAX_TURNS = options.interactionBridge ? (options.maxInteractionTurns ?? 10) : 1;

      while (turnCount < MAX_TURNS) {
        turnCount++;
        getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

        const turnResult = await runSessionPrompt(session, currentPrompt, options.timeoutSeconds * 1000);

        if (turnResult.timedOut) {
          timedOut = true;
          break;
        }

        lastResponse = turnResult.response;
        if (!lastResponse) break;

        // Accumulate token usage
        if (lastResponse.cumulative_token_usage) {
          totalTokenUsage.input_tokens += lastResponse.cumulative_token_usage.input_tokens ?? 0;
          totalTokenUsage.output_tokens += lastResponse.cumulative_token_usage.output_tokens ?? 0;
        }

        // Check for agent question → route to interaction bridge
        const outputText = extractOutput(lastResponse);
        const question = extractQuestion(outputText);
        if (!question || !options.interactionBridge) break;

        getSafeLogger()?.debug("acp-adapter", "Agent asked question, routing to interactionBridge", { question });

        try {
          const answer = await Promise.race([
            options.interactionBridge.onQuestionDetected(question),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("interaction timeout")), INTERACTION_TIMEOUT_MS),
            ),
          ]);
          currentPrompt = answer;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getSafeLogger()?.warn("acp-adapter", `InteractionBridge failed: ${msg}`);
          break;
        }
      }

      // Only warn if we exhausted turns while still receiving questions (interactive mode).
      // In non-interactive mode (MAX_TURNS=1) the loop always completes in 1 turn — not a warning.
      if (turnCount >= MAX_TURNS && options.interactionBridge) {
        getSafeLogger()?.warn("acp-adapter", "Reached max turns limit", { sessionName, maxTurns: MAX_TURNS });
      }
    } finally {
      // 6. Cleanup — always close session and client, then clear sidecar
      await closeAcpSession(session);
      await client.close().catch(() => {});
      if (options.featureName && options.storyId) {
        await clearAcpSession(options.workdir, options.featureName, options.storyId);
      }
    }

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

    const success = lastResponse?.stopReason === "end_turn";
    const output = extractOutput(lastResponse);

    const estimatedCost =
      totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
        : 0;

    return {
      success,
      exitCode: success ? 0 : 1,
      output: output.slice(-MAX_AGENT_OUTPUT_CHARS),
      rateLimited: false,
      durationMs,
      estimatedCost,
    };
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<string> {
    const model = _options?.model ?? "default";
    const timeoutMs = _options?.timeoutMs ?? 120_000; // 2-min safety net by default
    const permissionMode = _options?.dangerouslySkipPermissions ? "approve-all" : "default";

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      const cmdStr = `acpx --model ${model} ${this.name}`;
      const client = _acpAdapterDeps.createClient(cmdStr);
      await client.start();

      let session: AcpSession | null = null;
      try {
        // complete() is one-shot — ephemeral session, no session name, no sidecar
        session = await client.createSession({ agentName: this.name, permissionMode });

        // Enforce timeout via Promise.race — session.prompt() can hang indefinitely
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`complete() timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        timeoutPromise.catch(() => {}); // prevent unhandled rejection if promptPromise wins

        const promptPromise = session.prompt(prompt);

        let response: AcpSessionResponse;
        try {
          response = await Promise.race([promptPromise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.stopReason === "error") {
          throw new CompleteError("complete() failed: stop reason is error");
        }

        const text = response.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n")
          .trim();

        // ACP one-shot sessions wrap the response in a result envelope:
        // {"type":"result","subtype":"success","result":"<actual output>"}
        // Unwrap to return the actual content.
        let unwrapped = text;
        try {
          const envelope = JSON.parse(text) as Record<string, unknown>;
          if (envelope?.type === "result" && typeof envelope?.result === "string") {
            unwrapped = envelope.result;
          }
        } catch {
          // Not an envelope — use text as-is
        }

        if (!unwrapped) {
          throw new CompleteError("complete() returned empty output");
        }

        return unwrapped;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        const shouldRetry = isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES - 1;
        if (!shouldRetry) throw error;

        const backoffMs = 2 ** (attempt + 1) * 1000;
        getSafeLogger()?.warn("acp-adapter", "complete() rate limited, retrying", {
          backoffSeconds: backoffMs / 1000,
          attempt: attempt + 1,
        });
        await _acpAdapterDeps.sleep(backoffMs);
      } finally {
        if (session) {
          await session.close().catch(() => {});
        }
        await client.close().catch(() => {});
      }
    }

    throw lastError ?? new CompleteError("complete() failed with unknown error");
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    // Resolve model: explicit > config.models[tier] > config.models.balanced > fallback
    let modelDef = options.modelDef;
    if (!modelDef && options.config?.models) {
      const tier = options.modelTier ?? "balanced";
      const { resolveModel } = await import("../../config/schema");
      const models = options.config.models as Record<string, unknown>;
      const entry = models[tier] ?? models.balanced;
      if (entry) {
        try {
          modelDef = resolveModel(entry as Parameters<typeof resolveModel>[0]);
        } catch {
          // resolveModel can throw on malformed entries
        }
      }
    }
    modelDef ??= { provider: "anthropic", model: "claude-sonnet-4-5-20250514" };
    // Timeout: from options, or config, or fallback to 600s
    const timeoutSeconds =
      options.timeoutSeconds ?? (options.config?.execution?.sessionTimeoutSeconds as number | undefined) ?? 600;

    const result = await this.run({
      prompt: options.prompt,
      workdir: options.workdir,
      modelTier: options.modelTier ?? "balanced",
      modelDef,
      timeoutSeconds,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions ?? false,
      interactionBridge: options.interactionBridge,
      maxInteractionTurns: options.maxInteractionTurns,
      featureName: options.featureName,
      storyId: options.storyId,
      sessionRole: options.sessionRole,
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
