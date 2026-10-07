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
import { type ClientCapabilities, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  type AgentSessionProfile,
  type BackendOpenContext,
  getLogger,
  NaxError,
  type TranscriptDoc,
} from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  effortOptionId,
  modeFor,
  modelOptionId,
  offersValue,
  readOnlyFor,
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
import type { LaunchCandidate } from "#src/client/registry";
import {
  isUsableSessionId,
  type Restore,
  type RestoredWith,
  restoreSession,
  type SessionSetup,
} from "#src/client/resume";
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
  readonly configOptions: readonly SessionConfigOption[];
  readonly restoredWith?: RestoredWith;
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
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env: options.env });
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
  const setup = await sessionSetup(o);
  const session =
    o.restore === undefined
      ? await newSession(o, setup)
      : await restoreSession(o.restore, record, setup, o.link, (label, request) => step(o, label, request));
  await applyConfig(o, session.agentSessionId, session.configOptions);
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
  };
}

async function newSession(o: Opening, setup: SessionSetup): Promise<Established> {
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, ...setup }));
  if (!isUsableSessionId(created.sessionId)) throw backendUnavailable("session/new returned no usable session id");
  return { agentSessionId: created.sessionId, cwd: o.ctx.workdir, configOptions: created.configOptions ?? [] };
}

/** §6.3 step 3: start the tool host when the session has tools; its entry and Claude's `_meta` (§6.6, #2365). */
async function sessionSetup(o: Opening): Promise<SessionSetup> {
  const kind = o.options.entry?.preApproval;
  const meta = claudeSessionMeta(
    kind,
    o.ctx.tools.map((tool) => tool.name),
    readOnlyFor(o.ctx.profile, o.options.entry),
  );
  if (o.host === undefined) return meta === undefined ? { mcpServers: [] } : { mcpServers: [], _meta: { ...meta } };
  if (meta === undefined) throw capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools");
  const server = await o.host.start().catch((err: unknown) => {
    throw backendUnavailable(`the tool host could not start: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { mcpServers: [server], _meta: { ...meta } };
}

/** §6.3 step 5: the profile's mode, then the model, then the effort (S4b). Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const afterMode = await applyMode(o, sessionId, offered);
  const afterModel = await applyModel(o, sessionId, afterMode);
  await applyEffort(o, sessionId, afterModel);
}

async function applyMode(
  o: Opening,
  sessionId: string,
  offered: readonly SessionConfigOption[],
): Promise<readonly SessionConfigOption[]> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode === undefined) return offered;
  if (!offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }));
  return set.configOptions ?? offered;
}

async function applyModel(
  o: Opening,
  sessionId: string,
  offered: readonly SessionConfigOption[],
): Promise<readonly SessionConfigOption[]> {
  const model = o.options.model;
  if (model === undefined) return offered;
  const configId = modelOptionId(offered, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
  return set.configOptions ?? offered;
}

/** S4b spec §6.7: an effort the agent does not offer is skipped with a warning, as acpx does. */
async function applyEffort(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const effort = o.options.effort;
  if (effort === undefined) return;
  const configId = effortOptionId(offered, o.options.agentName, effort);
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
