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
import { resolvePermissions } from "../../config/permissions";
import { getSafeLogger } from "../../logger";
import { sleep, which } from "../../utils/bun-deps";
import { parseDecomposeOutput } from "../shared/decompose";
import { buildDecomposePromptAsync } from "../shared/decompose-prompt";
import { parseAgentError } from "./parse-agent-error";
import { writePromptAudit } from "./prompt-audit";
import { createSpawnAcpClient } from "./spawn-client";

import type { AdapterFailure } from "../../context/engine";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  CompleteResult,
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
  cumulative_token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
    cwd?: string,
    timeoutSeconds?: number,
    pidRegistry?: import("../../execution/pid-registry").PidRegistry,
  ): AcpClient {
    return createSpawnAcpClient(cmdStr, cwd, timeoutSeconds, pidRegistry);
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
): Promise<{ response: AcpSessionResponse | null; timedOut: boolean }> {
  const promptPromise = session.prompt(prompt);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let winner: AcpSessionResponse | "timeout";
  try {
    winner = await Promise.race([promptPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }

  if (winner === "timeout") {
    // Suppress the pending prompt rejection to prevent unhandled rejection after
    // cancelActivePrompt kills the acpx process (which causes an EPIPE rejection).
    promptPromise.catch(() => {});
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

function buildContextToolPreamble(options: AgentRunOptions): string {
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

function buildContextToolResult(name: string, result: string, status: "ok" | "error" = "ok"): string {
  return `<nax_tool_result name="${name}" status="${status}">
${result.trim()}
</nax_tool_result>

Continue the task.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class AcpAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly binary: string;
  readonly capabilities: AgentCapabilities;

  constructor(
    agentName: string,
    private readonly naxConfig: import("../../config").NaxConfig,
  ) {
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

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const startTime = Date.now();

    getSafeLogger()?.debug("acp-adapter", `Starting run for ${this.name}`, {
      model: options.modelDef.model,
      workdir: options.workdir,
      featureName: options.featureName,
      storyId: options.storyId,
      sessionRole: options.sessionRole,
    });

    // Honour the shutdown abort signal before issuing any new work.
    // Without this, hitting Ctrl+C could spawn a fresh acpx session during
    // shutdown and race with teardown.
    if (options.abortSignal?.aborted) {
      getSafeLogger()?.warn("acp-adapter", `Run aborted for ${this.name} (shutdown in progress)`, {
        storyId: options.storyId,
        featureName: options.featureName,
      });
      return {
        success: false,
        exitCode: 130,
        output: "Run aborted — shutdown in progress",
        rateLimited: false,
        durationMs: Date.now() - startTime,
        estimatedCost: 0,
        adapterFailure: {
          category: "availability",
          outcome: "fail-aborted",
          retriable: false,
          message: "Run aborted — shutdown in progress",
        },
      };
    }

    try {
      const result = await this._runWithClient(options, startTime, this.name);

      if (!result.success) {
        getSafeLogger()?.warn("acp-adapter", `Run failed for ${this.name}`, {
          exitCode: result.exitCode,
          ...(result.output ? { output: result.output.slice(0, 500) } : {}),
        });

        const parsed = _fallbackDeps.parseAgentError(result.output ?? "");
        if (parsed.type === "auth") {
          return {
            success: false,
            exitCode: result.exitCode ?? 1,
            output: result.output ?? "",
            rateLimited: false,
            durationMs: Date.now() - startTime,
            estimatedCost: result.estimatedCost ?? 0,
            adapterFailure: {
              category: "availability",
              outcome: "fail-auth",
              retriable: false,
              message: (result.output ?? "").slice(0, 500),
            },
          };
        }
        if (parsed.type === "rate-limit") {
          return {
            success: false,
            exitCode: result.exitCode ?? 1,
            output: result.output ?? "",
            rateLimited: true,
            durationMs: Date.now() - startTime,
            estimatedCost: result.estimatedCost ?? 0,
            adapterFailure: {
              category: "availability",
              outcome: "fail-rate-limit",
              retriable: true,
              message: (result.output ?? "").slice(0, 500),
              ...(parsed.retryAfterSeconds !== undefined && { retryAfterSeconds: parsed.retryAfterSeconds }),
            },
          };
        }
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const parsed = _fallbackDeps.parseAgentError(error.message);

      if (parsed.type === "auth") {
        return {
          success: false,
          exitCode: 1,
          output: error.message,
          rateLimited: false,
          durationMs: Date.now() - startTime,
          estimatedCost: 0,
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
          success: false,
          exitCode: 1,
          output: error.message,
          rateLimited: true,
          durationMs: Date.now() - startTime,
          estimatedCost: 0,
          adapterFailure: {
            category: "availability",
            outcome: "fail-rate-limit",
            retriable: true,
            message: error.message.slice(0, 500),
            ...(parsed.retryAfterSeconds !== undefined && { retryAfterSeconds: parsed.retryAfterSeconds }),
          },
        };
      }
      // Unknown error — return as failure result
      return {
        success: false,
        exitCode: 1,
        output: error.message,
        rateLimited: false,
        durationMs: Date.now() - startTime,
        estimatedCost: 0,
        adapterFailure: {
          category: "quality",
          outcome: "fail-unknown",
          retriable: false,
          message: error.message.slice(0, 500),
        },
      };
    }
  }

  private async _runWithClient(
    options: AgentRunOptions,
    startTime: number,
    agentName = this.name,
  ): Promise<AgentResult> {
    const cmdStr = `acpx --model ${options.modelDef.model} ${agentName}`;
    const client = _acpAdapterDeps.createClient(cmdStr, options.workdir, options.timeoutSeconds, options.pidRegistry);
    await client.start();

    // 1. Resolve session name: descriptor.handle > explicit sessionHandle > derived from options
    // Phase 3 (#477): crash guard and sidecar lookup removed — SessionManager owns crash recovery
    // via the CREATED/RUNNING state machine (orphan detection via sweepOrphans()).
    const sessionName =
      (options.session ? this.deriveSessionName(options.session) : undefined) ??
      options.sessionHandle ??
      computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);

    // 2. Resolve permission mode from config via single source of truth.
    const resolvedPerm = resolvePermissions(options.config, options.pipelineStage ?? "run");
    const permissionMode = resolvedPerm.mode;
    getSafeLogger()?.info("acp-adapter", "Permission mode resolved", {
      permission: permissionMode,
      stage: options.pipelineStage ?? "run",
    });

    // 3. Ensure session (resume existing or create new)
    const { session, resumed: sessionResumed } = await ensureAcpSession(client, sessionName, agentName, permissionMode);

    // Capture protocol IDs immediately after session is established (Phase 1 plumbing).
    // session.recordId is stable across reconnects; session.id is volatile.
    const protocolIds = {
      recordId: (session as { recordId?: string }).recordId ?? null,
      sessionId: (session as { id?: string }).id ?? null,
    };

    // #591: fire the established-callback NOW (before any prompt) so the
    // SessionManager can persist protocolIds eagerly. If the run is
    // interrupted before return, the on-disk descriptor still carries the
    // correlation needed to resume.
    if (options.onSessionEstablished) {
      try {
        options.onSessionEstablished(protocolIds, sessionName);
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "onSessionEstablished callback threw — continuing", {
          sessionName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
      const hasContextTools = Boolean(options.contextToolRuntime && (options.contextPullTools?.length ?? 0) > 0);
      let currentPrompt = buildContextToolPreamble(options);
      let turnCount = 0;
      const MAX_TURNS = options.interactionBridge || hasContextTools ? (options.maxInteractionTurns ?? 10) : 1;

      while (turnCount < MAX_TURNS) {
        turnCount++;
        getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

        // Audit: fire-and-forget prompt write — never blocks or throws
        const _runAuditConfig = options.config;
        if (_runAuditConfig?.agent?.promptAudit?.enabled) {
          void writePromptAudit({
            prompt: currentPrompt,
            sessionName,
            recordId: session.recordId,
            sessionId: session.id,
            workdir: options.workdir,
            projectDir: options.projectDir,
            auditDir: _runAuditConfig.agent.promptAudit.dir,
            storyId: options.storyId,
            featureName: options.featureName,
            pipelineStage: options.pipelineStage ?? "run",
            callType: "run",
            turn: turnCount,
            resumed: sessionResumed,
          });
        }

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
        const toolCall = isEndTurn ? extractContextToolCall(outputText) : null;
        if (toolCall && options.contextToolRuntime) {
          try {
            const toolResult = toolCall.error
              ? buildContextToolResult(toolCall.name, toolCall.error, "error")
              : buildContextToolResult(
                  toolCall.name,
                  await options.contextToolRuntime.callTool(toolCall.name, toolCall.input ?? {}),
                );
            currentPrompt = toolResult;
            continue;
          } catch (error) {
            currentPrompt = buildContextToolResult(
              toolCall.name,
              error instanceof Error ? error.message : String(error),
              "error",
            );
            continue;
          }
        }

        const question = isEndTurn ? extractQuestion(outputText) : null;
        if (!question || !options.interactionBridge) break;

        getSafeLogger()?.debug("acp-adapter", "Agent asked question, routing to interactionBridge", { question });

        let interactionTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const answer = await Promise.race([
            options.interactionBridge.onQuestionDetected(question),
            new Promise<never>((_, reject) => {
              interactionTimeoutId = setTimeout(() => reject(new Error("interaction timeout")), INTERACTION_TIMEOUT_MS);
            }),
          ]);
          currentPrompt = answer;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getSafeLogger()?.warn("acp-adapter", `InteractionBridge failed: ${msg}`);
          break;
        } finally {
          clearTimeout(interactionTimeoutId);
        }
      }

      // Only warn if we exhausted turns while still receiving questions (interactive mode).
      // In non-interactive mode (MAX_TURNS=1) the loop always completes in 1 turn — not a warning.
      if (turnCount >= MAX_TURNS && (options.interactionBridge || hasContextTools)) {
        getSafeLogger()?.warn("acp-adapter", "Reached max turns limit", { sessionName, maxTurns: MAX_TURNS });
      }

      // Compute success here so finally can use it for conditional close.
      runState.succeeded = !timedOut && lastResponse?.stopReason === "end_turn";
    } finally {
      // 6. Cleanup — close the physical ACP session on success or session-broken.
      // On failure (any), keep session open so retry can resume with context.
      // On success with keepOpen=true, keep open so the next turn resumes context.
      // Phase 3 (#477): sidecar writes removed — SessionManager owns persistence.
      const isSessionBroken = !runState.succeeded && lastResponse?.stopReason === "error";
      if ((runState.succeeded && !options.keepOpen) || isSessionBroken) {
        if (isSessionBroken) {
          getSafeLogger()?.debug("acp-adapter", "Closing broken session for retry", { sessionName });
        }
        await closeAcpSession(session);
      } else if (!runState.succeeded) {
        getSafeLogger()?.info("acp-adapter", "Keeping session open for retry", { sessionName });
      } else {
        getSafeLogger()?.debug("acp-adapter", "Keeping session open (keepOpen=true)", { sessionName });
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
        protocolIds,
        adapterFailure: {
          category: "quality",
          outcome: "fail-timeout",
          retriable: true,
          message: `Session timed out after ${options.timeoutSeconds}s`,
        },
      };
    }

    const success = lastResponse?.stopReason === "end_turn";
    const isSessionError = lastResponse?.stopReason === "error";
    const isSessionErrorRetryable = isSessionError && lastResponse?.retryable === true;
    const output = extractOutput(lastResponse);

    // Prefer exact cost from acpx usage_update; fall back to token-based estimation
    const estimatedCost =
      totalExactCostUsd ??
      (totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
        : 0);

    const tokenUsage =
      totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
        ? {
            inputTokens: totalTokenUsage.input_tokens,
            outputTokens: totalTokenUsage.output_tokens,
            ...(totalTokenUsage.cache_read_input_tokens > 0 && {
              cache_read_input_tokens: totalTokenUsage.cache_read_input_tokens,
            }),
            ...(totalTokenUsage.cache_creation_input_tokens > 0 && {
              cache_creation_input_tokens: totalTokenUsage.cache_creation_input_tokens,
            }),
          }
        : undefined;

    const adapterFailure: AdapterFailure | undefined = success
      ? undefined
      : isSessionError
        ? {
            category: "quality",
            outcome: "fail-adapter-error",
            retriable: isSessionErrorRetryable,
            message: "ACP session ended with error stopReason",
          }
        : {
            category: "quality",
            outcome: "fail-unknown",
            retriable: false,
            message: `Session ended with stopReason: ${lastResponse?.stopReason ?? "none"}`,
          };

    return {
      success,
      exitCode: success ? 0 : 1,
      output: output.slice(-MAX_AGENT_OUTPUT_CHARS),
      rateLimited: false,
      sessionError: isSessionError,
      sessionErrorRetryable: isSessionErrorRetryable,
      durationMs,
      estimatedCost,
      tokenUsage,
      protocolIds,
      adapterFailure,
    };
  }

  async complete(prompt: string, _options?: CompleteOptions): Promise<CompleteResult> {
    const timeoutMs = _options?.timeoutMs ?? 120_000;
    const permissionMode = resolvePermissions(_options?.config, "complete").mode;
    const workdir = _options?.workdir;
    const config = _options?.config;

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
      const client = _acpAdapterDeps.createClient(cmdStr, workdir, timeoutSeconds);
      await client.start();

      let session: AcpSession | null = null;
      let hadError = false;
      try {
        const completeSessionName =
          _options?.sessionName ??
          computeAcpHandle(workdir ?? process.cwd(), _options?.featureName, _options?.storyId, _options?.sessionRole);
        session = await client.createSession({ agentName, permissionMode, sessionName: completeSessionName });

        // Audit: fire-and-forget prompt write — never blocks or throws
        const _completeAuditConfig = config ?? this.naxConfig;
        if (_completeAuditConfig?.agent?.promptAudit?.enabled) {
          void writePromptAudit({
            prompt,
            sessionName: completeSessionName,
            recordId: session.recordId,
            sessionId: session.id,
            workdir: workdir ?? process.cwd(),
            auditDir: _completeAuditConfig.agent.promptAudit.dir,
            storyId: _options?.storyId,
            featureName: _options?.featureName,
            pipelineStage: _options?.pipelineStage ?? "complete",
            callType: "complete",
            resumed: false,
          });
        }

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
            costUsd: estimateCostFromTokenUsage(response.cumulative_token_usage, model),
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
      throw err;
    }
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    // Resolve model: explicit > resolveModelForAgent(tier) > fallback
    let modelDef = options.modelDef;
    if (!modelDef && options.config?.models) {
      const tier = options.modelTier ?? "balanced";
      const config = options.config;
      const { resolveModelForAgent } = await import("../../config/schema");
      try {
        const defaultAgent = config.agent?.default ?? "claude";
        modelDef = resolveModelForAgent(config.models ?? {}, defaultAgent, tier, defaultAgent);
      } catch {
        // resolveModelForAgent can throw on malformed entries
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
      dangerouslySkipPermissions: resolvePermissions(this.naxConfig, "plan").skipPermissions,
      pipelineStage: "plan",
      config: this.naxConfig,
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

    return { specContent, costUsd: result.estimatedCost };
  }

  async decompose(options: DecomposeOptions): Promise<DecomposeResult> {
    const model = options.modelDef?.model;
    const prompt = await buildDecomposePromptAsync(options);

    let output: string;
    try {
      const completeResult = await this.complete(prompt, {
        model,
        jsonMode: true,
        config: this.naxConfig,
        workdir: options.workdir,
        featureName: options.featureName,
        storyId: options.storyId,
        sessionRole: options.sessionRole ?? "decompose",
        timeoutMs:
          (this.naxConfig?.plan?.decomposeTimeoutSeconds ?? this.naxConfig?.plan?.timeoutSeconds ?? 300) * 1_000,
      });
      output = completeResult.output;
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

  async closeSession(sessionName: string, workdir: string): Promise<void> {
    await this.closePhysicalSession(sessionName, workdir);
  }
}
