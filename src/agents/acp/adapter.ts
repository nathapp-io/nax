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
import { resolvePermissions } from "../../config/permissions";
import { getSafeLogger } from "../../logger";
import { sleep, which } from "../../utils/bun-deps";
import { buildDecomposePrompt, parseDecomposeOutput } from "../shared/decompose";
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
  cumulative_token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Exact cost in USD from acpx usage_update event. Preferred over token-based estimation. */
  exactCostUsd?: number;
}

export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(options?: { forceTerminate?: boolean }): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

export interface AcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession>;
  /** Resume an existing named session. Returns null if the session is not found. */
  loadSession?(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null>;
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _acpAdapterDeps = {
  which,

  sleep,

  /**
   * Create an ACP client for the given command string.
   * Default: spawn-based client (shells out to acpx CLI).
   * Override in tests via: _acpAdapterDeps.createClient = mock(...)
   */
  createClient(
    cmdStr: string,
    cwd?: string,
    timeoutSeconds?: number,
    pidRegistry?: import("../../execution/pid-registry").PidRegistry,
  ): AcpClient {
    return createSpawnAcpClient(cmdStr, cwd, timeoutSeconds, pidRegistry);
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
  if (!agentName) {
    throw new Error("[acp-adapter] agentName is required for ensureAcpSession");
  }

  // Try to resume existing session first
  if (client.loadSession) {
    try {
      const existing = await client.loadSession(sessionName, agentName, permissionMode);
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
  return join(workdir, ".nax", "features", featureName, "acp-sessions.json");
}

/** Sidecar entry — session name + agent name for correct sweep/close. */
type SidecarEntry = string | { sessionName: string; agentName: string };

/** Extract sessionName from a sidecar entry (handles legacy string format). */
function sidecarSessionName(entry: SidecarEntry): string {
  return typeof entry === "string" ? entry : entry.sessionName;
}

/** Extract agentName from a sidecar entry (defaults to "claude" for legacy entries). */
function sidecarAgentName(entry: SidecarEntry): string {
  return typeof entry === "string" ? "claude" : entry.agentName;
}

/** Persist a session name to the sidecar file. Best-effort — errors are swallowed. */
export async function saveAcpSession(
  workdir: string,
  featureName: string,
  storyId: string,
  sessionName: string,
  agentName = "claude",
): Promise<void> {
  try {
    const path = acpSessionsPath(workdir, featureName);
    let data: Record<string, SidecarEntry> = {};
    try {
      const existing = await Bun.file(path).text();
      data = JSON.parse(existing);
    } catch {
      // File doesn't exist yet — start fresh
    }
    data[storyId] = { sessionName, agentName };
    await Bun.write(path, JSON.stringify(data, null, 2));
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to save session to sidecar", { error: String(err) });
  }
}

/** Clear a session name from the sidecar file. Best-effort — errors are swallowed. */
export async function clearAcpSession(
  workdir: string,
  featureName: string,
  storyId: string,
  sessionRole?: string,
): Promise<void> {
  try {
    const path = acpSessionsPath(workdir, featureName);
    let data: Record<string, string> = {};
    try {
      const existing = await Bun.file(path).text();
      data = JSON.parse(existing);
    } catch {
      return; // File doesn't exist — nothing to clear
    }
    const sidecarKey = sessionRole ? `${storyId}:${sessionRole}` : storyId;
    delete data[sidecarKey];
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
    const data: Record<string, SidecarEntry> = JSON.parse(existing);
    const entry = data[storyId];
    return entry ? sidecarSessionName(entry) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session sweep — close open sessions at run boundaries
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Close all open sessions tracked in the sidecar file for a feature.
 * Called at run-end to ensure no sessions leak past the run boundary.
 */
export async function sweepFeatureSessions(workdir: string, featureName: string): Promise<void> {
  const path = acpSessionsPath(workdir, featureName);
  let sessions: Record<string, SidecarEntry>;
  try {
    const text = await Bun.file(path).text();
    sessions = JSON.parse(text) as Record<string, SidecarEntry>;
  } catch {
    return; // No sidecar — nothing to sweep
  }

  const entries = Object.entries(sessions);
  if (entries.length === 0) return;

  const logger = getSafeLogger();
  logger?.info("acp-adapter", `[sweep] Closing ${entries.length} open sessions for feature: ${featureName}`);

  // Group sessions by agent name so we create one client per agent
  const byAgent = new Map<string, string[]>();
  for (const [, entry] of entries) {
    const agent = sidecarAgentName(entry);
    const name = sidecarSessionName(entry);
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent)?.push(name);
  }

  for (const [agentName, sessionNames] of byAgent) {
    const cmdStr = `acpx ${agentName}`;
    const client = _acpAdapterDeps.createClient(cmdStr, workdir);
    try {
      await client.start();
      for (const sessionName of sessionNames) {
        try {
          if (client.loadSession) {
            const session = await client.loadSession(sessionName, agentName, "approve-reads");
            if (session) {
              await session.close().catch(() => {});
            }
          }
        } catch (err) {
          logger?.warn("acp-adapter", `[sweep] Failed to close session ${sessionName}`, { error: String(err) });
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Clear sidecar after sweep
  try {
    await Bun.write(path, JSON.stringify({}, null, 2));
  } catch (err) {
    logger?.warn("acp-adapter", "[sweep] Failed to clear sidecar after sweep", { error: String(err) });
  }
}

/**
 * Sweep stale sessions if the sidecar file is older than maxAgeMs.
 * Called at startup as a safety net for sessions orphaned by crashes.
 */
export async function sweepStaleFeatureSessions(
  workdir: string,
  featureName: string,
  maxAgeMs = MAX_SESSION_AGE_MS,
): Promise<void> {
  const path = acpSessionsPath(workdir, featureName);
  const file = Bun.file(path);
  if (!(await file.exists())) return;

  const ageMs = Date.now() - file.lastModified;
  if (ageMs < maxAgeMs) return; // Recent sidecar — skip

  getSafeLogger()?.info(
    "acp-adapter",
    `[sweep] Sidecar is ${Math.round(ageMs / 60000)}m old — sweeping stale sessions`,
    {
      featureName,
      ageMs,
    },
  );

  await sweepFeatureSessions(workdir, featureName);
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
    const client = _acpAdapterDeps.createClient(cmdStr, options.workdir, options.timeoutSeconds, options.pidRegistry);
    await client.start();

    // 1. Resolve session name: explicit > sidecar > derived
    let sessionName = options.acpSessionName;
    if (!sessionName && options.featureName && options.storyId) {
      // #90: Key sidecar by storyId:role to prevent verifier resuming implementer's session
      const sidecarKey = options.sessionRole ? `${options.storyId}:${options.sessionRole}` : options.storyId;
      sessionName = (await readAcpSession(options.workdir, options.featureName, sidecarKey)) ?? undefined;
    }
    sessionName ??= buildSessionName(options.workdir, options.featureName, options.storyId, options.sessionRole);

    // 2. Resolve permission mode from config via single source of truth.
    const resolvedPerm = resolvePermissions(options.config, options.pipelineStage ?? "run");
    const permissionMode = resolvedPerm.mode;
    getSafeLogger()?.info("acp-adapter", "Permission mode resolved", {
      permission: permissionMode,
      stage: options.pipelineStage ?? "run",
    });

    // 3. Ensure session (resume existing or create new)
    const session = await ensureAcpSession(client, sessionName, this.name, permissionMode);

    // 4. Persist for plan→run continuity
    if (options.featureName && options.storyId) {
      const sidecarKey = options.sessionRole ? `${options.storyId}:${options.sessionRole}` : options.storyId;
      await saveAcpSession(options.workdir, options.featureName, sidecarKey, sessionName, this.name);
    }

    let lastResponse: AcpSessionResponse | null = null;
    let timedOut = false;
    // Tracks whether the run completed successfully — used by finally to decide
    // whether to close the session (success) or keep it open for retry (failure).
    const runState = { succeeded: false };
    const totalTokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    let totalExactCostUsd: number | undefined;

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

        // Accumulate token usage and exact cost
        if (lastResponse.cumulative_token_usage) {
          totalTokenUsage.input_tokens += lastResponse.cumulative_token_usage.input_tokens ?? 0;
          totalTokenUsage.output_tokens += lastResponse.cumulative_token_usage.output_tokens ?? 0;
          totalTokenUsage.cache_read_input_tokens += lastResponse.cumulative_token_usage.cache_read_input_tokens ?? 0;
          totalTokenUsage.cache_creation_input_tokens +=
            lastResponse.cumulative_token_usage.cache_creation_input_tokens ?? 0;
        }
        if (lastResponse.exactCostUsd !== undefined) {
          totalExactCostUsd = (totalExactCostUsd ?? 0) + lastResponse.exactCostUsd;
        }

        // Check for agent question → route to interaction bridge.
        // Only attempt question detection when stopReason === "end_turn": the agent
        // intentionally stopped and may be waiting for input. For max_tokens (truncated
        // output) or tool_use (mid-tool-call), skip detection to avoid false positives.
        const outputText = extractOutput(lastResponse);
        const isEndTurn = lastResponse.stopReason === "end_turn";
        const question = isEndTurn ? extractQuestion(outputText) : null;
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

      // Compute success here so finally can use it for conditional close.
      runState.succeeded = !timedOut && lastResponse?.stopReason === "end_turn";
    } finally {
      // 6. Cleanup — close session and clear sidecar only on success.
      // On failure, keep session open so retry can resume with full context.
      // When keepSessionOpen=true (e.g. rectification loop), skip close even on success
      // so all attempts share the same conversation context.
      if (runState.succeeded && !options.keepSessionOpen) {
        await closeAcpSession(session);
        if (options.featureName && options.storyId) {
          await clearAcpSession(options.workdir, options.featureName, options.storyId);
        }
      } else if (!runState.succeeded) {
        getSafeLogger()?.info("acp-adapter", "Keeping session open for retry", { sessionName });
      } else {
        getSafeLogger()?.debug("acp-adapter", "Keeping session open (keepSessionOpen=true)", { sessionName });
      }
      await client.close().catch(() => {});
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

    // Prefer exact cost from acpx usage_update; fall back to token-based estimation
    const estimatedCost =
      totalExactCostUsd ??
      (totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
        : 0);

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
    const permissionMode = resolvePermissions(_options?.config, "complete").mode;
    const workdir = _options?.workdir;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      const cmdStr = `acpx --model ${model} ${this.name}`;
      const client = _acpAdapterDeps.createClient(cmdStr, workdir);
      await client.start();

      let session: AcpSession | null = null;
      let hadError = false;
      try {
        // complete() is one-shot — ephemeral session, no sidecar
        // Use caller-provided sessionName if available; otherwise build from featureName/storyId/sessionRole
        const completeSessionName =
          _options?.sessionName ??
          buildSessionName(workdir ?? process.cwd(), _options?.featureName, _options?.storyId, _options?.sessionRole);
        session = await client.createSession({
          agentName: this.name,
          permissionMode,
          sessionName: completeSessionName,
        });

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

        if (response.exactCostUsd !== undefined) {
          getSafeLogger()?.info("acp-adapter", "complete() cost", {
            costUsd: response.exactCostUsd,
            model,
          });
        }

        return unwrapped;
      } catch (err) {
        hadError = true;
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
          await session.close({ forceTerminate: hadError }).catch(() => {});
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
      dangerouslySkipPermissions: resolvePermissions(
        options.config as import("../../config").NaxConfig | undefined,
        "plan",
      ).skipPermissions,
      pipelineStage: "plan",
      config: options.config as import("../../config").NaxConfig | undefined,
      interactionBridge: options.interactionBridge,
      maxInteractionTurns: options.maxInteractionTurns,
      featureName: options.featureName,
      storyId: options.storyId,
      sessionRole: options.sessionRole,
      pidRegistry: options.pidRegistry,
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
      output = await this.complete(prompt, {
        model,
        jsonMode: true,
        config: options.config as import("../../config").NaxConfig | undefined,
        workdir: options.workdir,
        sessionRole: "decompose",
      });
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
