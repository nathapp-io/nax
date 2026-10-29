/**
 * Opening an ACP session (S4 spec §6.3 step 1, §6.9): spawn, initialize (form
 * elicitation advertised under ask and full, S4-5 D5-l), capability check, the
 * tool host when the session has tools, then session/new (with the host's server
 * entry and the pre-approval _meta, §6.6) or, for a stored session, session/resume
 * or session/load with the same entry and _meta (resume.ts), then the profile's
 * mode and the model. A new session writes its initial transcript document; a
 * restored one leaves the document as it is (D6-f). Every failure after the spawn
 * kills the agent's process group before it propagates, so a failed open leaves
 * no process behind; the caller stops the tool host. Each agent request is
 * bounded by initializeTimeoutMs (D-c) and by openSignal: close() during open
 * rejects AGENT_SESSION_CLOSED.
 */
import { type ClientCapabilities, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  type AgentSessionProfile,
  type BackendOpenContext,
  getLogger,
  NaxError,
  type SandboxPolicy,
  type TranscriptDoc,
} from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  effortOptionId,
  MODEL_ID_MAX_CHARS,
  modeFor,
  modelOptionId,
  offersValue,
  readOnlyFor,
  resolveModelValue,
  selectValues,
  unmetRequirement,
} from "#src/client/capabilities";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import {
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  rpcErrorOf,
} from "#src/client/errors";
import { agentGoneError, type LaunchedAgent, type LaunchFn, pickCandidate } from "#src/client/launch";
import type { AcpProcessHooks, ResolvedAcpOptions } from "#src/client/options";
import { claudeSessionMeta } from "#src/client/pre-approval";
import { race } from "#src/client/race";
import type { AgentRegistryEntry, LaunchCandidate } from "#src/client/registry";
import {
  isUsableSessionId,
  type Restore,
  type RestoredWith,
  restoreSession,
  type SessionSetup,
} from "#src/client/resume";
import { policyLaunchEnv } from "#src/client/rule-policy";
import { type SessionOffers, sessionOffers } from "#src/client/session-offers";
import { startupBannerOf } from "#src/client/startup-banner";
import { cleanLabel } from "#src/client/text";
import type { ToolHost } from "#src/client/tool-host";

export interface OpenedAcp {
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly record: CapabilityRecord;
  readonly agentSessionId: string;
  /** The cwd the agent session was created with; a reconnect restores it with this spelling (D6-c). */
  readonly cwd: string;
  /** How a stored session was restored (§6.9); undefined for a new session. */
  readonly restoredWith?: RestoredWith;
  /** The startup banner session/new announced (nax#2591); turns drop it from their output. */
  readonly startupBanner?: string;
}

interface Opening {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly host: ToolHost | undefined;
  readonly restore: Restore | undefined;
}

/** The agent session before the mode and model are applied. */
interface Established {
  readonly agentSessionId: string;
  readonly cwd: string;
  readonly offers: SessionOffers;
  readonly restoredWith?: RestoredWith;
  readonly startupBanner?: string;
}

function chooseLaunch(options: ResolvedAcpOptions): LaunchCandidate {
  if (options.launch.kind === "explicit") return options.launch.candidate;
  const found = pickCandidate(options.launch.candidates, options.env.PATH);
  if (found !== undefined) return found;
  const tried = options.launch.candidates.map((candidate) => candidate.command);
  throw backendUnavailable(
    `no launch command for "${options.agentName}" was found on PATH (tried ${tried.join(", ")})`,
    {
      tried,
    },
  );
}

/** `restore`: restore that stored agent session instead of creating one (§6.9). */
export async function openAcpSession(
  options: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  handlers: InboundHandlers,
  launch: LaunchFn,
  host?: ToolHost,
  restore?: Restore,
): Promise<OpenedAcp> {
  if (ctx.openSignal.aborted) throw closedDuringOpen(ctx.sessionId);
  const candidate = chooseLaunch(options);
  // nax#2372: the profile's enforcement env (opencode's permission policy, translated from
  // the caller's read-tool deny rules) wins over the caller's, so a model's own
  // OPENCODE_CONFIG_CONTENT cannot weaken a read-only session. A rejection here refuses the
  // open before anything is launched (rule-policy.ts, US-004).
  const env = { ...options.env, ...(await policyLaunchEnv(ctx.profile, options)) };
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env });
  watchProcess(options.onProcess, launched);
  const link = openConnection(launched.target, handlers);
  void launched.exited.then(() =>
    link.close(new NaxError("The ACP agent process exited", "ACP_AGENT_EXITED", { stage: "acp" })),
  );
  try {
    return await establish({ options, ctx, launched, link, host, restore });
  } catch (err) {
    launched.kill();
    link.close();
    throw err;
  }
}

/** S4b spec §8: report the agent process to the embedder; a throwing hook is logged, never propagated. */
function watchProcess(hooks: AcpProcessHooks | undefined, launched: LaunchedAgent): void {
  const pid = launched.pid;
  if (hooks === undefined || pid === undefined) return;
  const ignored = (name: string) => (err: unknown) => {
    getLogger().warn("acp", `onProcess.${name} threw; ignored`, {
      error: err instanceof Error ? err.message : String(err),
    });
  };
  const call = (name: "spawned" | "exited"): void => {
    try {
      // An async hook's rejection is caught too; the hook is typed void, but async functions satisfy it.
      const result: unknown = hooks[name]?.(pid);
      if (result instanceof Promise) result.catch(ignored(name));
    } catch (err) {
      ignored(name)(err);
    }
  };
  call("spawned");
  void launched.exited.then(() => call("exited"));
}

async function step<T>(o: Opening, label: string, request: Promise<T>): Promise<T> {
  const result = await race(request, { timeoutMs: o.options.initializeTimeoutMs, signal: o.ctx.openSignal });
  switch (result.kind) {
    case "ok":
      return result.value;
    case "aborted":
      throw closedDuringOpen(o.ctx.sessionId);
    case "timeout":
      throw backendUnavailable(`${label} timed out after ${o.options.initializeTimeoutMs} ms`, {
        during: label,
        stderr: o.launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets: o.options.secrets }),
      });
    case "failed": {
      const rpc = rpcErrorOf(result.error);
      if (rpc !== undefined) throw openRequestError(label, rpc, o.options.secrets);
      throw await agentGoneError(label, o.launched, o.options.secrets);
    }
  }
}

/** §6.3 step 1.1: no fs and no terminal (R11); form elicitation under ask and full (§6.8, D5-l). */
export function clientCapabilitiesFor(profile: AgentSessionProfile): ClientCapabilities {
  return profile === "ask" || profile === "full" ? { elicitation: { form: {} } } : {};
}

async function establish(o: Opening): Promise<OpenedAcp> {
  const init = await step(
    o,
    "initialize",
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: clientCapabilitiesFor(o.ctx.profile) }),
  );
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw backendUnavailable(
      `the agent speaks ACP protocol version ${String(init.protocolVersion)}; this client speaks ${PROTOCOL_VERSION}`,
      { protocolVersion: String(init.protocolVersion).slice(0, 32) },
    );
  }
  const record = buildCapabilityRecord(init, o.options.entry);
  const unmet = unmetRequirement(record, {
    profile: o.ctx.profile,
    toolCount: o.ctx.tools.length,
    resume: o.restore !== undefined,
  });
  if (unmet !== undefined) throw capabilityUnsupported(unmet.capability, unmet.reason);
  const sandbox = sandboxFor(o.ctx, o.options.entry);
  const setup = await sessionSetup(o, sandbox);
  const session: Established =
    o.restore === undefined
      ? await newSession(o, setup)
      : await restoreSession(o.restore, record, setup, o.link, (label, request) => step(o, label, request));
  await applyConfig(o, session.agentSessionId, session.offers);
  if (o.restore === undefined) {
    await o.ctx.transcriptStore.save(o.ctx.sessionId, initialDoc(o, record, session.agentSessionId));
  }
  return {
    launched: o.launched,
    link: o.link,
    record,
    agentSessionId: session.agentSessionId,
    cwd: session.cwd,
    ...(session.restoredWith === undefined ? {} : { restoredWith: session.restoredWith }),
    ...(session.startupBanner === undefined ? {} : { startupBanner: session.startupBanner }),
  };
}

async function newSession(o: Opening, setup: SessionSetup): Promise<Established> {
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, ...setup }));
  if (!isUsableSessionId(created.sessionId)) throw backendUnavailable("session/new returned no usable session id");
  const startupBanner = startupBannerOf(created);
  return {
    agentSessionId: created.sessionId,
    cwd: o.ctx.workdir,
    offers: sessionOffers(created),
    ...(startupBanner === undefined ? {} : { startupBanner }),
  };
}

/**
 * nax#2500: review/full sessions with an embedder sandbox; an unusable one refuses
 * the open. nax#2372: only an agent that receives the sandbox (one with a
 * pre-approval channel — Claude) gets it; for any other the embedder sandbox is
 * ignored, so an unusable one does not refuse an open it was never meant for.
 */
function sandboxFor(ctx: BackendOpenContext, entry: AgentRegistryEntry | undefined): SandboxPolicy | undefined {
  if (entry?.preApproval === undefined) return undefined;
  if (ctx.profile !== "review" && ctx.profile !== "full") return undefined;
  if (ctx.sandbox === undefined) return undefined;
  if (ctx.sandbox.kind === "unavailable") {
    throw capabilityUnsupported("profile", `the sandbox is unavailable: ${ctx.sandbox.reason}`);
  }
  return ctx.sandbox.policy;
}

/** §6.3 step 3: start the tool host when the session has tools; its entry and Claude's `_meta` (§6.6, #2365). */
async function sessionSetup(o: Opening, sandbox: SandboxPolicy | undefined): Promise<SessionSetup> {
  const kind = o.options.entry?.preApproval;
  const meta = claudeSessionMeta(
    kind,
    o.host?.serverName ?? "",
    o.ctx.tools.map((tool) => tool.name),
    readOnlyFor(o.ctx.profile, o.options.entry),
    {
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(o.ctx.profile === "full" ? { lockSkipPermissions: true } : {}),
    },
  );
  if (o.host === undefined) return meta === undefined ? { mcpServers: [] } : { mcpServers: [], _meta: { ...meta } };
  // An agent with no pre-approval channel but a known MCP call identity (codex, cursor) gets the
  // host entry alone: nax recognises its calls by their shape, not by an adapter-side allow rule.
  if (meta === undefined && o.options.entry?.mcpCallIdentity === undefined) {
    throw capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools");
  }
  const server = await o.host.start().catch((err: unknown) => {
    throw backendUnavailable(`the tool host could not start: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (meta === undefined) return { mcpServers: [server] };
  return { mcpServers: [server], _meta: { ...meta } };
}

/** §6.3 step 5: the profile's mode, then the model, then the effort (S4b). Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offers: SessionOffers): Promise<void> {
  const afterMode = await applyMode(o, sessionId, offers);
  const afterModel = await applyModel(o, sessionId, afterMode);
  await applyEffort(o, sessionId, afterModel);
}

/**
 * The profile's mode. A config option offering the value is used first (the ACP 1.x
 * way); an agent that offers it only in its legacy `modes` block (Gemini) gets
 * session/set_mode, whose request carries the mode id alone and no config id. A mode
 * neither offers refuses the open.
 */
async function applyMode(o: Opening, sessionId: string, offers: SessionOffers): Promise<SessionOffers> {
  const mode = modeFor(o.ctx.profile, o.options.entry, o.options.rules, o.options.shellSandboxPlan !== undefined);
  if (mode === undefined) return offers;
  if (offersValue(offers.configOptions, mode.configId, mode.value)) {
    const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }));
    return { ...offers, configOptions: set.configOptions ?? offers.configOptions };
  }
  if (offers.modeIds.includes(mode.value)) {
    await step(o, "session/set_mode", o.link.setMode({ sessionId, modeId: mode.value }));
    return offers;
  }
  throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
}

/** At most this many offered ids, each cleaned and capped, go into a model refusal (agent-supplied text). */
const MAX_OFFERED_MODELS = 50;

/** The model ids the config options offer, raw: category "model" values in offer order. */
function configModelIds(offers: SessionOffers): string[] {
  return offers.configOptions.filter((option) => option.category === "model").flatMap((option) => selectValues(option));
}

/** The model ids a refusal names: the config options' ids first, then the legacy `models` block's, capped. */
function offeredModels(offers: SessionOffers, secrets: readonly string[]): string[] {
  return [...configModelIds(offers), ...offers.modelIds]
    .slice(0, MAX_OFFERED_MODELS)
    .map((id) => cleanLabel(id, secrets, MODEL_ID_MAX_CHARS) ?? "")
    .filter((id) => id !== "");
}

/**
 * The requested model: through a config option when one offers it (the ACP 1.x way),
 * else through the legacy session/set_model; an agent offering it in neither refuses
 * the open, naming every id it does offer. The requested name is first resolved against
 * the offered ids (resolveModelValue), so a settings-carrying id (Cursor) can be named
 * by its bare form; the config options' ids are used when there are any, else the
 * legacy block's.
 */
async function applyModel(o: Opening, sessionId: string, offers: SessionOffers): Promise<SessionOffers> {
  const requested = o.options.model;
  if (requested === undefined) return offers;
  const fromOptions = configModelIds(offers);
  const model = resolveModelValue(
    o.options.agentName,
    fromOptions.length > 0 ? fromOptions : offers.modelIds,
    requested,
    o.options.secrets,
  );
  const configId = modelOptionId(offers.configOptions, model);
  if (configId !== undefined) {
    const set = await step(
      o,
      "session/set_config_option",
      o.link.setConfigOption({ sessionId, configId, value: model }),
    );
    return { ...offers, configOptions: set.configOptions ?? offers.configOptions };
  }
  if (offers.modelIds.includes(model)) {
    await step(o, "session/set_model", o.link.setModel({ sessionId, modelId: model }));
    return offers;
  }
  const ids = offeredModels(offers, o.options.secrets);
  throw capabilityUnsupported(
    "model",
    `the agent offers no model option "${model}"; offered: ${ids.length === 0 ? "(none)" : ids.join(", ")}`,
    { offered: ids },
  );
}

/** S4b spec §6.7: an effort the agent does not offer is skipped with a warning, as acpx does. */
async function applyEffort(o: Opening, sessionId: string, offers: SessionOffers): Promise<void> {
  const effort = o.options.effort;
  if (effort === undefined) return;
  const configId = effortOptionId(offers.configOptions, o.options.agentName, effort);
  if (configId === undefined) {
    getLogger().warn("acp", "The agent offers no effort option for this value; effort skipped", {
      agent: o.options.agentName,
      effort,
    });
    return;
  }
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: effort }));
}

function initialDoc(o: Opening, record: CapabilityRecord, agentSessionId: string): TranscriptDoc {
  return {
    backend: o.options.kind,
    acp: {
      agentSessionId,
      agent: o.options.agentName,
      ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
      cwd: o.ctx.workdir,
    },
    messages: [],
    savedAt: new Date().toISOString(),
  };
}
