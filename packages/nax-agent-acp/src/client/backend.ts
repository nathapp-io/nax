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

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  type AgentSessionAdapter,
  type BackendInfo,
  type BackendOpenContext,
  getLogger,
  NaxError,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionConfigureInput,
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
import { createOwnToolLedger } from "#src/client/own-tool-calls";
import { decidePermission, type PermissionContext } from "#src/client/permissions";
import { race } from "#src/client/race";
import { canRestore, type Restore, storedSessionOf } from "#src/client/resume";
import { configureAcpSession } from "#src/client/session-configure";
import { shellSandboxPlan } from "#src/client/shell-sandbox";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostServerName, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";
import { type CostMeter, createCostMeter } from "#src/client/usage";

/** Test seam: the process launcher, the tool host factory and its server name. Production always uses launchAgent, createToolHost and newToolHostServerName. */
export const _acpBackendDeps: {
  launch: LaunchFn;
  createToolHost: typeof createToolHost;
  newToolHostServerName: () => string;
} = {
  launch: launchAgent,
  createToolHost,
  newToolHostServerName,
};

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
  /** The options a reconnect opens with; `configure` updates its model and effort as the agent accepts them. */
  base: ResolvedAcpOptions;
  /** The config options the live agent last reported (open, reconnect, configure); `configure` resolves against them. */
  configOptions: readonly SessionConfigOption[];
  readonly ctx: BackendOpenContext;
  /** The tool host's ACP server name, drawn once at open and kept across reconnects; undefined without tools. */
  readonly serverName: string | undefined;
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

/**
 * The host's options: nax#2517's rendered `## MCP servers` text, which the
 * agent's MCP client reads from `initialize`. Absent — an empty one counts as
 * absent, as in the native path — leaves the option off entirely.
 */
function toolHostOptions(ctx: BackendOpenContext): { instructions: string } | undefined {
  const instructions = ctx.providerInstructions;
  return instructions === undefined || instructions === "" ? undefined : { instructions };
}

/** Exported for its unit test; `./client` does not re-export it. */
export function toolHostFor(
  ctx: BackendOpenContext,
  router: InboundRouter,
  secrets: readonly string[],
  token: string | undefined,
  serverName?: string,
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
  const options = serverName === undefined ? toolHostOptions(ctx) : { ...(toolHostOptions(ctx) ?? {}), serverName };
  return _acpBackendDeps.createToolHost(calls, token, options);
}

/**
 * Permission requests and elicitations, decided by profile with the session's
 * redaction set. nax#2372: the embedder sandbox joins the permission context only
 * for an agent that actually receives it (one with a pre-approval channel); for any
 * other, a policy there would approve an escalation the agent never sandboxed.
 * US-003: the agent's name (which raw field carries a shell command) and the
 * session's rules join it too, so review with no sandbox can adjudicate a command.
 * US-004: an agent that reports MCP calls in structured fields (Codex, Cursor) gets a
 * per-turn own-tool ledger, so a proven call to the session's own tool host is allowed once.
 */
function routerFor(ctx: BackendOpenContext, options: ResolvedAcpOptions, serverName?: string): InboundRouter {
  const entry = options.entry;
  const sandbox = entry?.preApproval !== undefined && ctx.sandbox?.kind === "policy" ? ctx.sandbox.policy : undefined;
  const base: Omit<PermissionContext, "signal"> = {
    profile: ctx.profile,
    asks: ctx.asks,
    secrets: options.secrets,
    cwd: ctx.workdir,
    agentName: options.agentName,
    rules: options.rules,
    ...(sandbox === undefined
      ? {}
      : {
          sandbox,
          ...(ctx.sandbox?.kind === "policy" && ctx.sandbox.writeExemption !== undefined
            ? { writeExemption: ctx.sandbox.writeExemption }
            : {}),
        }),
    ...(options.shellSandboxPlan === undefined
      ? {}
      : {
          shellSandbox: {
            prefix: options.shellSandboxPlan.prefix,
            verify: options.shellSandboxPlan.verify,
            onUnwrapped: options.shellSandboxPlan.onUnwrapped,
          },
        }),
  };
  const identityKind = entry?.mcpCallIdentity;
  const toolNames = ctx.tools.map((t) => t.name);
  const ownTools =
    identityKind === undefined || serverName === undefined || toolNames.length === 0
      ? undefined
      : () => createOwnToolLedger({ kind: identityKind, serverName, toolNames });
  return createInboundRouter(
    (request, signal, isOwnToolCall) =>
      decidePermission(request, { ...base, signal, ...(isOwnToolCall === undefined ? {} : { isOwnToolCall }) }),
    (request, signal) => answerElicitation(request, { ...base, signal }),
    ownTools,
  );
}

/** One agent process: a new agent session, or `restore` restored in it (§6.3 step 1, §6.9). */
async function connect(
  base: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  restore: Restore | undefined,
  retiredTokens: readonly string[],
  serverName?: string,
): Promise<Live> {
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const tokens = token === undefined ? retiredTokens : [...retiredTokens, token];
  const tokenOptions = withTokens(base, tokens);
  const plan = await shellSandboxPlan(ctx.profile, tokenOptions, ctx.sandbox, ctx.workdir);
  const options = Object.freeze({ ...tokenOptions, ...(plan === undefined ? {} : { shellSandboxPlan: plan }) });
  const gone = new AbortController();
  const router = routerFor(ctx, options, serverName);
  const host = toolHostFor(ctx, router, options.secrets, token, serverName);
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
  const serverName = ctx.tools.length > 0 ? _acpBackendDeps.newToolHostServerName() : undefined;
  const live = await connect(base, ctx, restore, [], serverName);
  return assemble({
    base,
    configOptions: live.acp.configOptions,
    ctx,
    serverName,
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
  const { record, restoredWith, offered } = s.live.acp;
  const capabilities = {
    ...record,
    offeredModels: offered.models,
    offeredEfforts: offered.efforts,
    ...(restoredWith === undefined ? {} : { restoredWith }),
  };
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
    acceptsImages: async () => s.live.acp.record.image,
    configure: (change) => configure(s, change),
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
    s.live = await connect(s.base, ctx, restore, old.tokens, s.serverName);
    s.configOptions = s.live.acp.configOptions;
    return s.live;
  } catch (err) {
    if (!signal.aborted && !s.ctx.openSignal.aborted) s.lost = true;
    throw err;
  }
}

/** US-002: model and effort set on the live process; each accepted part is recorded for a reconnect. */
async function configure(s: AcpSession, change: SessionConfigureInput): Promise<void> {
  const live = await liveFor(s, s.ctx.openSignal);
  await configureAcpSession(
    {
      link: live.acp.link,
      agentSessionId: live.acp.agentSessionId,
      agentName: s.base.agentName,
      secrets: live.options.secrets,
      timeoutMs: s.base.initializeTimeoutMs,
      signal: s.ctx.openSignal,
      sessionId: s.ctx.sessionId,
      configOptions: s.configOptions,
      change,
    },
    (part, configOptions) => {
      s.base = Object.freeze({ ...s.base, ...part });
      s.configOptions = configOptions;
    },
  );
}

async function sendTurn(s: AcpSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const signal = opts.signal ?? s.ctx.turnSignal();
  const live = await liveFor(s, signal);
  if (opts.images?.length && !live.acp.record.image) {
    throw new NaxError("[acp] The agent does not support image input", "ACP_IMAGE_INPUT_UNSUPPORTED", { stage: "acp" });
  }
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
    ...(live.acp.startupBanner === undefined ? {} : { startupBanner: live.acp.startupBanner }),
  });
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, {
      text,
      signal,
      collector,
      ...(opts.images === undefined ? {} : { images: opts.images }),
    });
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
