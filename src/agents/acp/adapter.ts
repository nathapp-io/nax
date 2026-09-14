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

import { getSafeLogger } from "@/logger";
import type { ProtocolIds } from "@/runtime/protocol-types";
import type { ITokenUsageMapper, TokenUsage } from "../cost";
import { addTokenUsage, estimateCostUsd } from "../cost";
import { createTurnDeadline } from "../turn-deadline";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRunOptions,
  CompleteResult,
  OpenSessionOpts,
  ResolvedCompleteOptions,
  SendTurnOpts,
  SessionHandle,
  TurnResult,
} from "../types";
import { SessionTurnError } from "../types";
import { closePhysicalSession as closePhysicalSessionImpl } from "./adapter-close-physical";
import { runCompleteFlow } from "./adapter-complete-flow";
import {
  _acpAdapterDeps,
  AcpSessionHandleImpl,
  closeAcpSession,
  ensureAcpSession,
  raceWithAbort,
  runSessionPrompt,
  throwIfAborted,
  warnWallClockTimeout,
} from "./adapter-lifecycle";
import { buildTurnResult, extractContextToolCall, extractOutput, extractQuestion } from "./adapter-output";
import { resolveRegistryEntry } from "./agent-entries";
import { defaultAcpTokenUsageMapper } from "./token-mapper";
import type { SessionTokenUsage } from "./wire-types";

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat re-exports (consumers import from this file via barrel)
// ─────────────────────────────────────────────────────────────────────────────

export {
  _acpAdapterDeps,
  _fallbackDeps,
  AcpSessionHandleImpl,
  closeAcpSession,
  computeAcpHandle,
  ensureAcpSession,
  runSessionPrompt,
} from "./adapter-lifecycle";
export type { BuildTurnResultInput } from "./adapter-output";
export {
  buildContextToolPreamble,
  buildRunInteractionHandler,
  buildTurnResult,
  deriveTokenUsage,
} from "./adapter-output";
export type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter-session-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants / agent registry
// ─────────────────────────────────────────────────────────────────────────────

const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for human to respond

export { ACP_ADAPTER_NAMES } from "./agent-entries";

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

  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    // US-002: resolve the rate card ONCE per complete() call. Both the success
    // and the cancelled-but-billable path price from it, and its `source`
    // becomes CompleteResult.pricingSource. The flow itself lives in
    // `adapter-complete-flow.ts` (file-size split, see project conventions).
    const rateCard = await _acpAdapterDeps.resolveRateCard(options.modelDef.model);
    return runCompleteFlow({
      adapter: this,
      prompt,
      options,
      mapper: this._mapper,
      rateCard,
      createClient: _acpAdapterDeps.createClient,
    });
  }

  async closePhysicalSession(
    handle: string,
    workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    return closePhysicalSessionImpl(this.name, handle, workdir, options);
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

    // US-002: resolve the rate card ONCE here. The handle carries it, so every
    // sendTurn on this session reuses it rather than re-resolving per turn.
    const rateCard = await _acpAdapterDeps.resolveRateCard(modelDef.model);

    const cmdStr = `acpx --model ${modelDef.model} ${agentName}`;
    const client = _acpAdapterDeps.createClient(
      cmdStr,
      workdir,
      timeoutSeconds,
      onPidSpawned,
      promptRetries,
      onPidExited,
      {
        onStreamActivity: opts.onStreamActivity,
        onActiveCall: opts.onActiveCall,
        trackedSpawnDeadlineMs: opts.trackedSpawnDeadlineMs,
        trackedSpawnStartupDeadlineMs: opts.trackedSpawnStartupDeadlineMs,
        env: modelDef.env,
      },
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
        modelTier: opts.modelTier,
        rateCard,
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
    // US-002: the card was resolved once at openSession — a turn reads it off
    // the handle and never re-resolves.
    const { _sessionName: sessionName, _timeoutSeconds: timeoutSeconds, _rateCard: rateCard } = impl;
    let sessionRecreated = false;
    const { interactionHandler, signal } = opts;
    // ACP spends the budget as this loop's bound, which is its intended use:
    // the sub-agent's own tool calling happens inside one session.prompt(),
    // so an iteration here is always a nax-side interaction. Native differs.
    const maxInteractions = opts.maxInteractions ?? 10;
    const turnDeadline = createTurnDeadline(timeoutSeconds);

    let totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalExactCostUsd: number | undefined;
    // Mid-turn human Q&A exchanges captured for the prompt-audit trail (issue #1226).
    // Only human-question round-trips are recorded — context-tool pulls are excluded.
    const interactions: import("../types").InteractionExchange[] = [];
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
        // US-002: openSession already resolved the card. Zero cost, but a
        // consumer can still tell this row's card from the derived fallback.
        pricingSource: rateCard.source,
      };
    }

    while (turnCount < maxInteractions) {
      if (turnDeadline.expired()) {
        timedOut = true;
        warnWallClockTimeout(sessionName, timeoutSeconds);
        break;
      }
      turnCount++;
      getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${maxInteractions}`, { sessionName });

      const turnResult = await runSessionPrompt(impl._session, currentPrompt, turnDeadline.remainingMs() ?? 0, signal);

      if (turnResult.timedOut) {
        timedOut = true;
        warnWallClockTimeout(sessionName, timeoutSeconds);
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

        // BUG-18 — this path previously raced only against `signal` (abort),
        // with no deadline: a hung interaction handler (e.g. a black-holing
        // webhook URL) stalled the story indefinitely. Mirrors the `question`
        // block below, which already races against INTERACTION_TIMEOUT_MS.
        let contextToolTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            raceWithAbort(interactionHandler.onInteraction(interaction), signal, "Run aborted — shutdown in progress"),
            new Promise<null>((resolve) => {
              contextToolTimeoutId = setTimeout(() => resolve(null), INTERACTION_TIMEOUT_MS);
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
            `InteractionHandler.onInteraction failed for context-tool: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          clearTimeout(contextToolTimeoutId);
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
            interactions.push({ turnIndex: turnCount, question, reply: response.answer });
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

    if (turnCount >= maxInteractions && !timedOut && !aborted && maxInteractions > 1) {
      getSafeLogger()?.warn("acp-adapter", "Interaction budget spent", { sessionName, maxInteractions });
    }

    if (lastResponse?.stopReason === "error") {
      // Surface transport facts (SessionManager maps `cancelled`->fail-stale;
      // build-hop-callback maps `retryable`). BUG-57: also carry accumulated cost.
      const hasUsage = totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0;
      throw new SessionTurnError(
        lastResponse.cancelled
          ? "Agent session ended with stop reason: error (externally cancelled)"
          : "Agent session ended with stop reason: error",
        lastResponse.cancelled === true,
        lastResponse.retryable === true,
        totalTokenUsage,
        hasUsage ? estimateCostUsd(totalTokenUsage, rateCard.rates) : 0,
        totalExactCostUsd,
        // US-002: name the card that priced the burned tokens so the error
        // row's estimate is attributable, like every other ACP result.
        rateCard.source,
      );
    }

    return buildTurnResult({
      lastResponse,
      totalTokenUsage,
      totalExactCostUsd,
      turnCount,
      interactions,
      timedOut,
      rateCard,
    });
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
