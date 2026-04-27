/**
 * ACP Agent Adapter — implements AgentAdapter interface via ACP session protocol.
 *
 * All methods use the createClient injectable as the transport layer.
 * Session lifecycle (naming, persistence, ensure/close) is handled by
 * thin wrapper functions on top of AcpClient/AcpSession.
 *
 * Session naming: nax-<gitRootHash8>-<feature>-<story>[-<role>]
 * Persistence: SessionManager disk-backed descriptors at .nax/features/<feature>/sessions/<id>/descriptor.json
 *
 * See: docs/specs/acp-session-mode.md
 */

import { createHash } from "node:crypto";
import { getSafeLogger } from "../../logger";
import { sleep, which } from "../../utils/bun-deps";
import type { InteractionHandler } from "../interaction-handler";
import { parseAgentError } from "./parse-agent-error";
import { createSpawnAcpClient } from "./spawn-client";

import type { ModelDef } from "../../config/schema";
import type { ProtocolIds } from "../../session/types";
import type { TokenUsage } from "../cost";
import { addTokenUsage, estimateCostFromTokenUsage } from "../cost";
import type { ITokenUsageMapper } from "../cost";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRunOptions,
  CompleteOptions,
  CompleteResult,
  OpenSessionOpts,
  SendTurnOpts,
  SessionHandle,
  TurnResult,
} from "../types";
import { CompleteError } from "../types";
import { defaultAcpTokenUsageMapper } from "./token-mapper";
import type { AgentRegistryEntry } from "./types";
import type { SessionTokenUsage } from "./wire-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_AGENT_OUTPUT_CHARS = 5000;
const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for human to respond
const CONTEXT_TOOL_CALL_PATTERN = /<nax_tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/nax_tool_call>/i;

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
  cumulative_token_usage?: SessionTokenUsage;
  /** Exact cost in USD from acpx usage_update event. Preferred over token-based estimation. */
  exactCostUsd?: number;
  /** True if acpx signalled the error is retryable (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION). */
  retryable?: boolean;
}

export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(options?: { forceTerminate?: boolean }): Promise<void>;
  cancelActivePrompt(): Promise<void>;
  /** Volatile session ID: updated by acpx on each Claude Code reconnect (acpxSessionId). */
  readonly id?: string;
  /** Stable record ID: assigned at session creation, never changes across reconnects (acpxRecordId). */
  readonly recordId?: string;
}

export interface AcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession>;
  /** Resume an existing named session. Returns null if the session is not found. */
  loadSession?(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null>;
  /** Close a named session directly without first ensuring/loading it. */
  closeSession?(sessionName: string, agentName: string): Promise<void>;
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
    cwd: string,
    timeoutSeconds?: number,
    onPidSpawned?: (pid: number) => void,
    promptRetries?: number,
  ): AcpClient {
    return createSpawnAcpClient(cmdStr, cwd, timeoutSeconds, onPidSpawned, promptRetries);
  },
};

/**
 * Injectable dependencies for the fallback retry loop in complete() and run().
 * Override in tests to mock parseAgentError and sleep.
 *
 * Fallback logging uses getSafeLogger() with stage 'agent-fallback'.
 * Log data always has storyId as the first key, followed by
 * originalAgent, fallbackAgent, errorType, and retryCount (AC6).
 * Unit tests for this interface are in:
 *   test/unit/agents/acp/adapter-fallback-logging.test.ts
 */
export const _fallbackDeps = {
  parseAgentError,
  sleep,
};

function createAbortError(signal?: AbortSignal, fallback = "Run aborted"): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(fallback);
}

function throwIfAborted(signal?: AbortSignal, fallback?: string): void {
  if (signal?.aborted) {
    throw createAbortError(signal, fallback);
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, fallback?: string): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw createAbortError(signal, fallback);
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal, fallback));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveRegistryEntry(agentName: string): AgentRegistryEntry {
  return AGENT_REGISTRY[agentName] ?? DEFAULT_ENTRY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic ACP session handle.
 *
 * Format: nax-<gitRootHash8>-<featureName>-<storyId>[-<sessionRole>]
 *
 * The workdir hash (first 8 chars of SHA-256) prevents cross-repo and
 * cross-worktree session name collisions. Each git worktree has a distinct
 * root path, so different worktrees of the same repo get different hashes.
 */
export function computeAcpHandle(
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
): Promise<{ session: AcpSession; resumed: boolean }> {
  if (!agentName) {
    throw new Error("[acp-adapter] agentName is required for ensureAcpSession");
  }

  // Try to resume existing session first
  if (client.loadSession) {
    try {
      const existing = await client.loadSession(sessionName, agentName, permissionMode);
      if (existing) {
        getSafeLogger()?.debug("acp-adapter", `Resumed existing session: ${sessionName}`);
        return { session: existing, resumed: true };
      }
    } catch {
      // loadSession failed — fall through to createSession
    }
  }

  // Create a new named session
  getSafeLogger()?.debug("acp-adapter", `Creating new session: ${sessionName}`);
  return { session: await client.createSession({ agentName, permissionMode, sessionName }), resumed: false };
}

/**
 * Send a prompt turn to the session with timeout.
 * If the timeout fires, attempts to cancel the active prompt and returns timedOut=true.
 */
export async function runSessionPrompt(
  session: AcpSession,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: AcpSessionResponse | null; timedOut: boolean; aborted: boolean }> {
  throwIfAborted(signal, "Run aborted — shutdown in progress");
  const promptPromise = session.prompt(prompt);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let abortHandler: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<"aborted">((resolve) => {
        abortHandler = () => resolve("aborted");
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  let winner: AcpSessionResponse | "timeout" | "aborted";
  try {
    winner = await Promise.race([promptPromise, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    clearTimeout(timeoutId);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }

  if (winner === "timeout" || winner === "aborted") {
    // Suppress the pending prompt rejection to prevent unhandled rejection after
    // cancelActivePrompt kills the acpx process (which causes an EPIPE rejection).
    promptPromise.catch(() => {});
    try {
      await session.cancelActivePrompt();
    } catch {
      await session.close().catch(() => {});
    }
    return { response: null, timedOut: winner === "timeout", aborted: winner === "aborted" };
  }

  return { response: winner as AcpSessionResponse, timedOut: false, aborted: false };
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
// SessionHandle implementation (Phase A — adapter-internal)
// ─────────────────────────────────────────────────────────────────────────────

export class AcpSessionHandleImpl implements SessionHandle {
  readonly id: string;
  readonly agentName: string;
  readonly protocolIds: ProtocolIds;

  // ACP-internal fields — opaque to callers above the adapter boundary.
  readonly _client: AcpClient;
  readonly _session: AcpSession;
  readonly _sessionName: string;
  readonly _resumed: boolean;
  readonly _timeoutSeconds: number;
  readonly _modelDef: ModelDef;

  constructor(opts: {
    id: string;
    agentName: string;
    protocolIds: ProtocolIds;
    client: AcpClient;
    session: AcpSession;
    sessionName: string;
    resumed: boolean;
    timeoutSeconds: number;
    modelDef: ModelDef;
  }) {
    this.id = opts.id;
    this.agentName = opts.agentName;
    this.protocolIds = opts.protocolIds;
    this._client = opts.client;
    this._session = opts.session;
    this._sessionName = opts.sessionName;
    this._resumed = opts.resumed;
    this._timeoutSeconds = opts.timeoutSeconds;
    this._modelDef = opts.modelDef;
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

  // BUG-097: Only check the last non-empty line for question marks.
  // Scanning all sentences caused false positives on code snippets mid-output
  // containing ?. (optional chaining), ?? (nullish coalescing), or ternary ?.
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines.at(-1)?.trim() ?? "";

  // Keyword markers — also scoped to the last line to avoid mid-message false positives
  const lower = lastLine.toLowerCase();
  const markers = [
    "please confirm",
    "please specify",
    "please provide",
    "which would you",
    "should i ",
    "do you want",
    "can you clarify",
  ];

  const isQuestion = (lastLine.endsWith("?") && lastLine.length > 10) || markers.some((m) => lower.includes(m));

  if (!isQuestion) return null;

  // Return the last two paragraphs so the caller has full context.
  // Paragraph boundary = one or more blank lines (\n\n+).
  //
  // Agents often structure their final turn as:
  //   <long output: tables, code blocks, AC coverage>
  //   \n\n
  //   <conclusion sentence: "All tests pass. Nothing more to do.">  ← paragraph[-2]
  //   \n\n
  //   <question: "Would you like me to:\n1. ...\n3. X?">            ← paragraph[-1]
  //
  // Returning only paragraph[-1] drops the conclusion sentence that explains
  // WHY the agent is asking — leaving the user without meaningful context.
  const paragraphs = text.split(/\n\n+/);
  const questionPara = paragraphs.at(-1)?.trim() ?? lastLine;
  const contextPara = paragraphs.at(-2)?.trim();
  return contextPara ? `${contextPara}\n\n${questionPara}` : questionPara;
}

function extractContextToolCall(output: string): { name: string; input?: unknown; error?: string } | null {
  const match = output.match(CONTEXT_TOOL_CALL_PATTERN);
  if (!match) return null;

  const [, name, rawInput] = match;
  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return { name, input: {} };
  }

  try {
    return { name, input: JSON.parse(trimmedInput) as unknown };
  } catch (error) {
    return {
      name,
      error: `Invalid JSON tool input: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function buildContextToolPreamble(options: AgentRunOptions): string {
  const tools = options.contextPullTools;
  if (!tools || tools.length === 0 || !options.contextToolRuntime) {
    return options.prompt;
  }

  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description} (max ${tool.maxCallsPerSession} calls/session)`)
    .join("\n");

  return `${options.prompt}

## Context Pull Tools
When you need more repo context, you may request one tool call by replying with exactly:
<nax_tool_call name="tool_name">
{"key":"value"}
</nax_tool_call>

Available tools:
${toolList}

After you receive a <nax_tool_result ...> block, continue the task normally.`;
}

function buildContextToolResult(name: string, result: string, status: "ok" | "error" = "ok"): string {
  return `<nax_tool_result name="${name}" status="${status}">
${result.trim()}
</nax_tool_result>

Continue the task.`;
}

export function buildRunInteractionHandler(options: AgentRunOptions): InteractionHandler {
  const { contextToolRuntime, contextPullTools, interactionBridge } = options;
  const hasContextTools = Boolean(contextToolRuntime && (contextPullTools?.length ?? 0) > 0);

  return {
    async onInteraction(req) {
      if (req.kind === "context-tool") {
        if (!hasContextTools || !contextToolRuntime) return null;
        try {
          const toolResult = req.error
            ? buildContextToolResult(req.name, req.error, "error")
            : buildContextToolResult(req.name, await contextToolRuntime.callTool(req.name, req.input ?? {}));
          return { answer: toolResult };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { answer: buildContextToolResult(req.name, msg, "error") };
        }
      }
      if (req.kind === "question") {
        if (!interactionBridge) return null;
        const answer = await interactionBridge.onQuestionDetected(req.text);
        return { answer };
      }
      return null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class AcpAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly binary: string;
  readonly capabilities: AgentCapabilities;
  private readonly _mapper: ITokenUsageMapper<SessionTokenUsage>;

  constructor(agentName: string, mapper: ITokenUsageMapper<SessionTokenUsage> = defaultAcpTokenUsageMapper) {
    const entry = resolveRegistryEntry(agentName);
    this.name = agentName;
    this.displayName = entry.displayName;
    this.binary = entry.binary;
    this._mapper = mapper;
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

  deriveSessionName(descriptor: import("../../session/types").SessionDescriptor): string {
    return computeAcpHandle(descriptor.workdir, descriptor.featureName, descriptor.storyId, descriptor.role);
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

  async complete(prompt: string, _options?: CompleteOptions): Promise<CompleteResult> {
    const timeoutMs = _options?.timeoutMs ?? 120_000;
    const permissionMode = _options?.resolvedPermissions?.mode ?? "approve-reads";
    const workdir = _options?.workdir;
    if (!workdir) {
      throw new Error("[acp-adapter] complete() requires workdir in options");
    }
    // Resolve model for a given agent name
    const resolveModel = async (agentName: string): Promise<string> => {
      let model = _options?.model;
      if (!model && _options?.modelTier && _options?.config?.models) {
        const tier = _options.modelTier;
        const { resolveModelForAgent } = await import("../../config/schema");
        try {
          model = resolveModelForAgent(
            _options.config.models,
            agentName,
            tier,
            _options.config.agent?.default ?? agentName,
          ).model;
        } catch {
          // fall through to "default"
        }
      }
      return model ?? "default";
    };

    // Attempt one call with the given agent; throws on any error
    const tryOneAgent = async (agentName: string): Promise<CompleteResult> => {
      const model = await resolveModel(agentName);
      const cmdStr = `acpx --model ${model} ${agentName}`;
      const timeoutSeconds = Math.ceil(timeoutMs / 1000);
      const promptRetries = _options?.config?.agent?.acp?.promptRetries;
      const client = _acpAdapterDeps.createClient(cmdStr, workdir, timeoutSeconds, undefined, promptRetries);
      await client.start();

      let session: AcpSession | null = null;
      let hadError = false;
      try {
        const completeSessionName =
          _options?.sessionName ??
          computeAcpHandle(workdir, _options?.featureName, _options?.storyId, _options?.sessionRole);
        session = await client.createSession({ agentName, permissionMode, sessionName: completeSessionName });

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`complete() timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        timeoutPromise.catch(() => {});

        let response: AcpSessionResponse;
        try {
          response = await Promise.race([session.prompt(prompt), timeoutPromise]);
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
          getSafeLogger()?.info("acp-adapter", "complete() cost", { costUsd: response.exactCostUsd, model });
          return {
            output: unwrapped,
            costUsd: response.exactCostUsd,
            source: "exact",
          };
        }

        if (response.cumulative_token_usage) {
          return {
            output: unwrapped,
            costUsd: estimateCostFromTokenUsage(this._mapper.toInternal(response.cumulative_token_usage), model),
            source: "estimated",
          };
        }

        return {
          output: unwrapped,
          costUsd: 0,
          source: "fallback",
        };
      } catch (err) {
        hadError = true;
        throw err;
      } finally {
        if (session) {
          await session.close({ forceTerminate: hadError }).catch(() => {});
        }
        await client.close().catch(() => {});
      }
    };

    try {
      return await tryOneAgent(this.name);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const parsed = _fallbackDeps.parseAgentError(error.message);
      if (parsed.type === "auth") {
        return {
          output: error.message,
          costUsd: 0,
          source: "fallback",
          adapterFailure: {
            category: "availability",
            outcome: "fail-auth",
            retriable: false,
            message: error.message.slice(0, 500),
          },
        };
      }
      if (parsed.type === "rate-limit") {
        return {
          output: error.message,
          costUsd: 0,
          source: "fallback",
          adapterFailure: {
            category: "availability",
            outcome: "fail-rate-limit",
            retriable: true,
            message: error.message.slice(0, 500),
            ...(parsed.retryAfterSeconds !== undefined && { retryAfterSeconds: parsed.retryAfterSeconds }),
          },
        };
      }
      if (parsed.type === "model-not-available") {
        return {
          output: error.message,
          costUsd: 0,
          source: "fallback",
          adapterFailure: {
            category: "quality",
            outcome: "fail-adapter-error",
            retriable: false,
            message: error.message.slice(0, 500),
          },
        };
      }
      throw err;
    }
  }

  async closePhysicalSession(handle: string, workdir: string, options?: { force?: boolean }): Promise<void> {
    const cmdStr = `acpx ${this.name}`;
    const client = _acpAdapterDeps.createClient(cmdStr, workdir, undefined, undefined);
    try {
      await client.start();
      try {
        if (client.closeSession) {
          await client.closeSession(handle, this.name);
          // AC-83: hard-terminate (acpx stop) when force=true, e.g. for errored sessions
          if (options?.force) {
            await (client as { forceStop?: (agentName: string) => Promise<void> })
              .forceStop?.(this.name)
              .catch(() => {});
          }
        } else if (client.loadSession) {
          const session = await client.loadSession(handle, this.name, "approve-reads");
          if (session) await session.close({ forceTerminate: options?.force }).catch(() => {});
        }
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", `[close] Failed to close session ${handle}`, { error: String(err) });
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  async openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    // opts.resume is a hint — the ACP adapter always attempts loadSession first
    // via ensureAcpSession, so it is inherently self-resuming regardless of this flag.
    const {
      agentName,
      workdir,
      resolvedPermissions,
      modelDef,
      timeoutSeconds,
      promptRetries,
      onSessionEstablished,
      onPidSpawned,
    } = opts;
    const { signal } = opts;

    throwIfAborted(signal, "Run aborted — shutdown in progress");

    const cmdStr = `acpx --model ${modelDef.model} ${agentName}`;
    const client = _acpAdapterDeps.createClient(cmdStr, workdir, timeoutSeconds, onPidSpawned, promptRetries);
    let session: AcpSession | undefined;

    try {
      await raceWithAbort(client.start(), signal, "Run aborted — shutdown in progress");

      const permissionMode = resolvedPermissions.mode;
      getSafeLogger()?.info("acp-adapter", "Permission mode resolved", {
        permission: permissionMode,
        stage: "open-session",
      });

      const ensured = await raceWithAbort(
        ensureAcpSession(client, name, agentName, permissionMode),
        signal,
        "Run aborted — shutdown in progress",
      );
      session = ensured.session;

      const protocolIds: ProtocolIds = {
        recordId: (session as { recordId?: string }).recordId ?? null,
        sessionId: (session as { id?: string }).id ?? null,
      };

      if (onSessionEstablished) {
        try {
          onSessionEstablished(protocolIds, name);
        } catch (err) {
          getSafeLogger()?.warn("acp-adapter", "onSessionEstablished callback threw — continuing", {
            sessionName: name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      throwIfAborted(signal, "Run aborted — shutdown in progress");

      return new AcpSessionHandleImpl({
        id: name,
        agentName,
        protocolIds,
        client,
        session,
        sessionName: name,
        resumed: ensured.resumed,
        timeoutSeconds,
        modelDef,
      });
    } catch (error) {
      if (session) {
        await closeAcpSession(session).catch(() => {});
      }
      await client.close().catch(() => {});
      throw error;
    }
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    const impl = handle as AcpSessionHandleImpl;
    const { _session: session, _sessionName: sessionName, _timeoutSeconds: timeoutSeconds, _modelDef: modelDef } = impl;
    const { interactionHandler, signal } = opts;
    const MAX_TURNS = opts.maxTurns ?? 10;

    let totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalExactCostUsd: number | undefined;
    let turnCount = 0;
    let lastResponse: AcpSessionResponse | null = null;
    let timedOut = false;
    let aborted = false;
    let currentPrompt = prompt;

    if (signal?.aborted) {
      return {
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      };
    }

    while (turnCount < MAX_TURNS) {
      turnCount++;
      getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

      const turnResult = await runSessionPrompt(session, currentPrompt, timeoutSeconds * 1000, signal);

      if (turnResult.timedOut) {
        timedOut = true;
        break;
      }
      if (turnResult.aborted) {
        aborted = true;
        break;
      }

      lastResponse = turnResult.response;
      if (!lastResponse) break;

      if (lastResponse.cumulative_token_usage) {
        totalTokenUsage = addTokenUsage(totalTokenUsage, this._mapper.toInternal(lastResponse.cumulative_token_usage));
      }
      if (lastResponse.exactCostUsd !== undefined) {
        totalExactCostUsd = (totalExactCostUsd ?? 0) + lastResponse.exactCostUsd;
      }

      const outputText = extractOutput(lastResponse);
      const isEndTurn = lastResponse.stopReason === "end_turn";
      const toolCall = isEndTurn ? extractContextToolCall(outputText) : null;

      if (toolCall) {
        const interaction: import("../interaction-handler").AdapterInteraction = toolCall.error
          ? { kind: "context-tool", name: toolCall.name, error: toolCall.error }
          : { kind: "context-tool", name: toolCall.name, input: toolCall.input };

        try {
          const response = await raceWithAbort(
            interactionHandler.onInteraction(interaction),
            signal,
            "Run aborted — shutdown in progress",
          );
          if (response) {
            currentPrompt = response.answer;
            continue;
          }
        } catch (err) {
          if (signal?.aborted) {
            aborted = true;
            break;
          }
          getSafeLogger()?.warn(
            "acp-adapter",
            `InteractionHandler.onInteraction failed for context-tool: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }

      const question = isEndTurn ? extractQuestion(outputText) : null;
      if (question) {
        let interactionTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            raceWithAbort(
              interactionHandler.onInteraction({ kind: "question", text: question }),
              signal,
              "Run aborted — shutdown in progress",
            ),
            new Promise<null>((resolve) => {
              interactionTimeoutId = setTimeout(() => resolve(null), INTERACTION_TIMEOUT_MS);
            }),
          ]);
          if (response) {
            currentPrompt = response.answer;
            continue;
          }
        } catch (err) {
          if (signal?.aborted) {
            aborted = true;
            break;
          }
          getSafeLogger()?.warn(
            "acp-adapter",
            `InteractionHandler.onInteraction failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          clearTimeout(interactionTimeoutId);
        }
      }

      break;
    }

    if (turnCount >= MAX_TURNS && !timedOut && !aborted && MAX_TURNS > 1) {
      getSafeLogger()?.warn("acp-adapter", "Reached max turns limit", { sessionName, maxTurns: MAX_TURNS });
    }

    if (lastResponse?.stopReason === "error") {
      throw new Error("Agent session ended with stop reason: error");
    }

    const output = extractOutput(lastResponse);
    const tokenUsage = totalTokenUsage;

    const estimatedCostUsd =
      totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, modelDef.model)
        : 0;
    const exactCostUsd = totalExactCostUsd; // undefined if wire never reported

    return {
      output,
      tokenUsage,
      estimatedCostUsd,
      exactCostUsd,
      internalRoundTrips: turnCount,
    };
  }

  async closeSession(handle: SessionHandle): Promise<void> {
    const impl = handle as AcpSessionHandleImpl;
    try {
      await closeAcpSession(impl._session);
    } finally {
      await impl._client.close().catch(() => {});
    }
  }
}
