/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. Embedder tools are served by a per-session MCP
 * tool host (§6.6, tool-host.ts) and pre-approved at the adapter (R12); the
 * host's token joins the session's redaction set before the agent starts (D4-i).
 * The agent's updates become turn events with per-turn usage priced by one cost
 * meter per session (§6.7, events.ts, usage.ts), and its form elicitations become
 * questions under `ask` and `full` (§6.8, elicitation.ts). A turn's permission
 * decisions, questions and tool calls are cancelled when the turn is cancelled,
 * times out, ends or loses its process (D3-d, D4-f, D5-j). Until its stage lands
 * it refuses resume (S4-6) before spawning anything. A crashed or killed agent
 * leaves the session disconnected; reconnect is S4-6, so until then later turns
 * end AGENT_SESSION_CLOSED (D-f).
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
import { answerElicitation } from "#src/client/elicitation";
import { capabilityUnsupported } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";
import { type CostMeter, createCostMeter } from "#src/client/usage";

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
  /** The embedder tools' MCP host; undefined when the session has no tools. */
  readonly host: ToolHost | undefined;
  /** The agent process's cumulative cost readings, one meter per process (D5-b). */
  readonly meter: CostMeter;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}

/** The session's options: the tool host's token joins the redaction set (D4-i). */
function withToken(options: ResolvedAcpOptions, token: string | undefined): ResolvedAcpOptions {
  if (token === undefined) return options;
  return Object.freeze({ ...options, secrets: Object.freeze([...options.secrets, token]) });
}

function toolHostFor(
  ctx: BackendOpenContext,
  router: InboundRouter,
  secrets: readonly string[],
  token: string | undefined,
): ToolHost | undefined {
  if (token === undefined) return undefined;
  const calls = createToolCalls({
    sessionId: ctx.sessionId,
    tools: ctx.tools,
    asks: ctx.asks,
    currentTurnId: ctx.currentTurnId,
    turnSignal: () => router.activeSignal(),
    secrets,
  });
  return createToolHost(calls, token);
}

/** Permission requests and elicitations, decided by profile with the session's redaction set. */
function routerFor(ctx: BackendOpenContext, secrets: readonly string[]): InboundRouter {
  const base = { profile: ctx.profile, asks: ctx.asks, secrets };
  return createInboundRouter(
    (request, signal) => decidePermission(request, { ...base, signal }),
    (request, signal) => answerElicitation(request, { ...base, signal }),
  );
}

async function openBackend(base: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const options = withToken(base, token);
  const gone = new AbortController();
  const router = routerFor(ctx, options.secrets);
  const host = toolHostFor(ctx, router, options.secrets, token);
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch, host).catch(
    async (err: unknown) => {
      await host?.stop();
      throw err;
    },
  );
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
  return assemble({ options, ctx, acp, router, flags, state, gone, host, meter: createCostMeter() });
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
  const collector = createTurnCollector(opts.onTurnEvent, { secrets: live.options.secrets, meter: live.meter });
  const signal = opts.signal ?? ctx.turnSignal();
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
    // The release aborted this turn's tool calls; wait for their answers (D4-f).
    await live.host?.drain();
    // Held text and calls left without a result go out before turn_end (D5-e, D5-g).
    collector.finish();
  }
}

async function shutdown(live: Live): Promise<void> {
  const { acp, options, flags } = live;
  if (!flags.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  // §6.3 close step 4: stop the tool host and revoke its token.
  await live.host?.stop();
  await saveFinal(live.ctx.transcriptStore, live.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
