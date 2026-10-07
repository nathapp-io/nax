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

import type { ProtocolIds } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import type { ITokenUsageMapper } from "../cost";
import { raceWithAbort, throwIfAborted } from "../turn";
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
import { closePhysicalSession as closePhysicalSessionImpl } from "./adapter-close-physical";
import { runCompleteFlow } from "./adapter-complete-flow";
import { _acpAdapterDeps, AcpSessionHandleImpl, closeAcpSession, ensureAcpSession } from "./adapter-lifecycle";
import { buildSendTurnFrame, initialSendTurnState, runTurnLoop, zeroCostAbortedResult } from "./adapter-send-turn";
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
    // the handle and never re-resolves. The turn loop itself lives in
    // `adapter-send-turn.ts` (complexity split); this method sequences it.
    const frame = buildSendTurnFrame({ impl, mapper: this._mapper, opts });
    if (frame.opts.signal?.aborted) {
      return zeroCostAbortedResult(frame);
    }
    return runTurnLoop(frame, initialSendTurnState(prompt));
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
