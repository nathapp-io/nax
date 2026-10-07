/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. Embedder tools are served by a per-session MCP
 * tool host (§6.6, tool-host.ts) and pre-approved at the adapter (R12); the
 * host's token joins the session's redaction set before the agent starts (D4-i).
 * The agent's updates become turn events with per-turn usage priced by one cost
 * meter per agent process (§6.7, events.ts, usage.ts), and its form elicitations
 * become questions under `ask` and `full` (§6.8, elicitation.ts). A turn's
 * permission decisions, questions and tool calls are cancelled when the turn is
 * cancelled, times out, ends or loses its process (D3-d, D4-f, D5-j).
 *
 * A stored session is restored with session/resume, else session/load, never as
 * a fresh one (§6.9, resume.ts). A crashed or killed agent leaves the session
 * disconnected; the next turn reconnects once the same way, with a new process,
 * router and tool host token, and the cost baseline carried over (§6.3 step 5,
 * S4-6 D6-a, D6-g). An agent that can do neither, or a reconnect that fails,
 * leaves the session closed: later turns end AGENT_SESSION_CLOSED. The baseline
 * is written to the transcript document after each priced turn, so a resume in a
 * new process prices its first turn from it (D6-a).
 */
import {
  type AgentSessionAdapter,
  type BackendInfo,
  type BackendOpenContext,
  getLogger,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { answerElicitation } from "#src/client/elicitation";
import { sessionLost } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { canRestore, type Restore, storedSessionOf } from "#src/client/resume";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";
import { type CostMeter, createCostMeter } from "#src/client/usage";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

/** One agent process and everything bound to it. A reconnect replaces it whole (D6-g). */
interface Live {
  readonly options: ResolvedAcpOptions;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly state: TurnState;
  /** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */
  readonly gone: AbortController;
  /** The embedder tools' MCP host; undefined when the session has no tools. */
  readonly host: ToolHost | undefined;
  /** The process's cumulative cost readings (D5-b), seeded with the session's baseline (D6-a). */
  readonly meter: CostMeter;
  /** Every tool host token the session has used; retired ones stay in the redaction set (D6-g). */
  readonly tokens: readonly string[];
  /** Set when the process exits or is killed. */
  readonly status: { disconnected: boolean };
}

/** The session across its agent processes. */
interface AcpSession {
  readonly base: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  live: Live;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
  /** No reconnect is possible any more: later turns end AGENT_SESSION_CLOSED (§6.3 step 5). */
  lost: boolean;
  /** The cost baseline the transcript document holds (D6-a). */
  savedBaseline: number;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

/** The process's options: the session's tool host tokens join the redaction set (D4-i, D6-g). */
function withTokens(options: ResolvedAcpOptions, tokens: readonly string[]): ResolvedAcpOptions {
  if (tokens.length === 0) return options;
  return Object.freeze({ ...options, secrets: Object.freeze([...options.secrets, ...tokens]) });
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

/** One agent process: a new agent session, or `restore` restored in it (§6.3 step 1, §6.9). */
async function connect(
  base: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  restore: Restore | undefined,
  retiredTokens: readonly string[],
): Promise<Live> {
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const tokens = token === undefined ? retiredTokens : [...retiredTokens, token];
  const options = withTokens(base, tokens);
  const gone = new AbortController();
  const router = routerFor(ctx, options.secrets);
  const host = toolHostFor(ctx, router, options.secrets, token);
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch, host, restore).catch(
    async (err: unknown) => {
      await host?.stop();
      throw err;
    },
  );
  const status = { disconnected: false };
  void acp.launched.exited.then(() => {
    status.disconnected = true;
    gone.abort();
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      status.disconnected = true;
    },
  };
  const meter = createCostMeter(restore?.costUsd ?? 0);
  return { options, acp, router, state, gone, host, meter, tokens, status };
}

async function openBackend(base: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  // §6.9 step 1 runs before anything is spawned.
  const restore = ctx.resume === undefined ? undefined : storedSessionOf(ctx.resume.doc, ctx, base);
  const live = await connect(base, ctx, restore, []);
  return assemble({
    base,
    ctx,
    live,
    closing: undefined,
    // A restored agent already holds the instructions once a turn has run (D6-f).
    instructionsSent: ctx.resume?.doc.turn !== undefined,
    lost: false,
    savedBaseline: restore?.costUsd ?? 0,
  });
}

/** D6-h: the live process's capability record; a restored process adds restoredWith. */
function infoOf(s: AcpSession): BackendInfo {
  const { record, restoredWith } = s.live.acp;
  const capabilities = restoredWith === undefined ? { ...record } : { ...record, restoredWith };
  return Object.freeze({ kind: s.base.kind, capabilities: Object.freeze(capabilities) });
}

function assemble(s: AcpSession): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: s.ctx.sessionId, agentName: s.base.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(s, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    // Read at access: a reconnect replaces the process and its capability record (D6-h).
    get info() {
      return infoOf(s);
    },
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      s.closing ??= shutdown(s);
      return s.closing;
    },
  };
}

/** The process a turn runs on: reconnects once after a crash or kill (§6.3 step 5). */
async function liveFor(s: AcpSession, signal: AbortSignal): Promise<Live> {
  if (s.closing !== undefined || s.lost) {
    throw sessionLost(s.ctx.sessionId, "its agent process is gone and cannot be reconnected");
  }
  if (!s.live.status.disconnected) return s.live;
  if (!canRestore(s.live.acp.record)) {
    s.lost = true;
    throw sessionLost(
      s.ctx.sessionId,
      "its agent process is gone and the agent supports neither session/resume nor session/load",
    );
  }
  return reconnect(s, signal);
}

/** D6-g: a new process restores the session; a stopped attempt may be retried, a failed one ends the session. */
async function reconnect(s: AcpSession, signal: AbortSignal): Promise<Live> {
  const old = s.live;
  old.acp.launched.kill();
  old.acp.link.close();
  // The old tool host stops and its token is revoked (§6.6).
  await old.host?.stop();
  const restore: Restore = {
    agentSessionId: old.acp.agentSessionId,
    cwd: old.acp.cwd,
    costUsd: old.meter.baseline(),
  };
  // close() aborts openSignal; cancel() and the turn timeout abort the turn signal.
  const ctx: BackendOpenContext = { ...s.ctx, openSignal: AbortSignal.any([s.ctx.openSignal, signal]) };
  try {
    s.live = await connect(s.base, ctx, restore, old.tokens);
    return s.live;
  } catch (err) {
    if (!signal.aborted && !s.ctx.openSignal.aborted) s.lost = true;
    throw err;
  }
}

async function sendTurn(s: AcpSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const signal = opts.signal ?? s.ctx.turnSignal();
  const live = await liveFor(s, signal);
  const instructions = s.instructionsSent ? undefined : s.ctx.instructions;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  // #2364: delivered once the agent shows it has the prompt, not when it is sent.
  const onReceipt =
    instructions === undefined
      ? undefined
      : () => {
          s.instructionsSent = true;
        };
  const collector = createTurnCollector(opts.onTurnEvent, {
    secrets: live.options.secrets,
    meter: live.meter,
    ...(onReceipt === undefined ? {} : { onReceipt }),
  });
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
    // The release aborted this turn's tool calls; wait for their answers (D4-f).
    await live.host?.drain();
    // Held text and calls left without a result go out before turn_end (D5-e, D5-g).
    collector.finish();
    await saveBaseline(s, live.meter.baseline());
  }
}

/** D6-a: load-merge the baseline into the document. Best effort: a failure is logged, never fatal. */
async function saveBaseline(s: AcpSession, baseline: number): Promise<void> {
  if (baseline === s.savedBaseline) return;
  const { transcriptStore: store, sessionId } = s.ctx;
  try {
    const doc = await store.load(sessionId);
    if (doc?.acp === undefined) return;
    await store.save(sessionId, { ...doc, acp: { ...doc.acp, costUsd: baseline } });
    s.savedBaseline = baseline;
  } catch {
    warn("Could not save the ACP cost baseline", sessionId);
  }
}

function warn(message: string, sessionId: string): void {
  try {
    getLogger().warn("acp", message, { sessionId });
  } catch {
    // A throwing host logger must not fail the turn.
  }
}

async function shutdown(s: AcpSession): Promise<void> {
  const { acp, options, status, host } = s.live;
  if (!status.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  // §6.3 close step 4: stop the tool host and revoke its token.
  await host?.stop();
  await saveFinal(s.ctx.transcriptStore, s.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker and the baseline. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
