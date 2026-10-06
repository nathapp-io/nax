/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. A turn's decisions are cancelled when the turn
 * is cancelled, times out, ends or loses its process (D3-d). Until their stages
 * land it refuses, before spawning anything: embedder tools (S4-4) and resume
 * (S4-6). A crashed or killed agent leaves the session disconnected; reconnect is
 * S4-6, so until then later turns end AGENT_SESSION_CLOSED (D-f).
 */
import {
  type AgentSessionAdapter,
  AgentSessionError,
  type BackendOpenContext,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { capabilityUnsupported } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { runPromptTurn, type TurnState } from "#src/client/turn";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

interface SessionFlags {
  disconnected: boolean;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
}

interface Live {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly flags: SessionFlags;
  readonly state: TurnState;
  /** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */
  readonly gone: AbortController;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.tools.length > 0) throw capabilityUnsupported("tools", "embedder tools on ACP arrive in S4-4");
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}

async function openBackend(options: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const gone = new AbortController();
  const router = createInboundRouter((request, signal) =>
    decidePermission(request, { profile: ctx.profile, asks: ctx.asks, secrets: options.secrets, signal }),
  );
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch);
  const flags: SessionFlags = { disconnected: false, closing: undefined, instructionsSent: false };
  void acp.launched.exited.then(() => {
    flags.disconnected = true;
    gone.abort();
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      flags.disconnected = true;
    },
  };
  return assemble({ options, ctx, acp, router, flags, state, gone });
}

function assemble(live: Live): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: live.ctx.sessionId, agentName: live.options.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(live, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    info: Object.freeze({ kind: live.options.kind, capabilities: live.acp.record }),
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      live.flags.closing ??= shutdown(live);
      return live.flags.closing;
    },
  };
}

async function sendTurn(live: Live, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const { ctx, flags } = live;
  if (flags.disconnected || flags.closing !== undefined) {
    throw new AgentSessionError(
      `ACP session "${ctx.sessionId}" has lost its agent process; reconnect arrives in S4-6`,
      "AGENT_SESSION_CLOSED",
      { sessionId: ctx.sessionId },
    );
  }
  const instructions = flags.instructionsSent ? undefined : ctx.instructions;
  flags.instructionsSent = true;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  const collector = createTurnCollector(opts.onTurnEvent);
  const signal = opts.signal ?? ctx.turnSignal();
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
  }
}

async function shutdown(live: Live): Promise<void> {
  const { acp, options, flags } = live;
  if (!flags.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  await saveFinal(live.ctx.transcriptStore, live.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
