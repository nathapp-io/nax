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

import { getSafeLogger } from "../../logger";
import type { ProtocolIds } from "../../runtime/protocol-types";
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

import {
  AcpSessionHandleImpl,
  _acpAdapterDeps,
  _fallbackDeps,
  closeAcpSession,
  computeAcpHandle,
  ensureAcpSession,
  raceWithAbort,
  runSessionPrompt,
  throwIfAborted,
} from "./adapter-lifecycle";
import { extractContextToolCall, extractOutput, extractQuestion } from "./adapter-output";

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat re-exports (consumers import from this file via barrel)
// ─────────────────────────────────────────────────────────────────────────────

export type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter-session-types";
export {
  AcpSessionHandleImpl,
  _acpAdapterDeps,
  _fallbackDeps,
  closeAcpSession,
  computeAcpHandle,
  ensureAcpSession,
  runSessionPrompt,
} from "./adapter-lifecycle";
export { buildContextToolPreamble, buildRunInteractionHandler } from "./adapter-output";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_AGENT_OUTPUT_CHARS = 5000;
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

function resolveRegistryEntry(agentName: string): AgentRegistryEntry {
  return AGENT_REGISTRY[agentName] ?? DEFAULT_ENTRY;
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
      const client = _acpAdapterDeps.createClient(
        cmdStr,
        workdir,
        timeoutSeconds,
        _options?.onPidSpawned,
        promptRetries,
        _options?.onPidExited,
      );
      await client.start();

      let session: import("./adapter-session-types").AcpSession | null = null;
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

        let response: import("./adapter-session-types").AcpSessionResponse;
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
      } finally {
        if (session) {
          // Always force-terminate on the complete-path: each complete() opens its
          // own session and never reuses it, so the queue-owner has no work to amortize.
          // Graceful close leaves the queue-owner alive until TTL — long enough to be
          // orphaned if the user quits nax (or hits Ctrl+C) before the TTL elapses.
          await session.close({ forceTerminate: true }).catch(() => {});
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
      onPidExited,
    } = opts;
    const { signal } = opts;

    throwIfAborted(signal, "Run aborted — shutdown in progress");

    const cmdStr = `acpx --model ${modelDef.model} ${agentName}`;
    const client = _acpAdapterDeps.createClient(
      cmdStr,
      workdir,
      timeoutSeconds,
      onPidSpawned,
      promptRetries,
      onPidExited,
    );
    let session: import("./adapter-session-types").AcpSession | undefined;

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
        permissionMode: resolvedPermissions.mode,
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
    const { _sessionName: sessionName, _timeoutSeconds: timeoutSeconds, _modelDef: modelDef } = impl;
    let sessionRecreated = false;
    const { interactionHandler, signal } = opts;
    const MAX_TURNS = opts.maxTurns ?? 10;

    let totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalExactCostUsd: number | undefined;
    let turnCount = 0;
    let lastResponse: import("./adapter-session-types").AcpSessionResponse | null = null;
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

      const turnResult = await runSessionPrompt(impl._session, currentPrompt, timeoutSeconds * 1000, signal);

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

      // NO_SESSION recovery: acpx session expired server-side (exit code 4).
      // Re-establish and retry this turn once — don't count the dead attempt.
      //
      // ADR-019 boundary note: ADR-019 §2 makes SessionManager the owner of session
      // lifecycle (open/close, descriptor state, turn count). This recovery
      // intentionally does NOT involve SessionManager — it is a transport-level
      // reconnect of the underlying acpx session, analogous to a TCP reconnect under
      // an HTTP keep-alive. The SessionManager-facing identity (`handle.id`,
      // `_sessionName`) is unchanged; descriptor state stays `RUNNING`; only the
      // opaque `_session` pointer is swapped. If future recovery work needs to
      // reset descriptor state or invalidate turn count, that belongs in
      // SessionManager.runInSession (catch a typed RetryableSessionError from the
      // adapter and call `openSession` again at the orchestrator layer).
      if (lastResponse.exitCode === 4 && !sessionRecreated) {
        sessionRecreated = true;
        getSafeLogger()?.info("acp-adapter", "NO_SESSION detected — re-establishing session", { sessionName });
        try {
          const ensured = await ensureAcpSession(impl._client, impl._sessionName, impl.agentName, impl._permissionMode);
          impl._session = ensured.session;
          turnCount--;
          continue;
        } catch (err) {
          getSafeLogger()?.warn("acp-adapter", "Session re-establishment failed after NO_SESSION", {
            sessionName,
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through to error throw at end of loop
        }
      }

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
