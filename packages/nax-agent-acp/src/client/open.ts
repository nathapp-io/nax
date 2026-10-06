/**
 * Opening an ACP session (S4 spec §6.3 step 1): spawn, initialize, capability
 * check, the tool host when the session has tools, session/new (with the host's
 * server entry and the pre-approval _meta, §6.6), the profile's mode, then the
 * model, then the initial transcript document. Every failure after the spawn
 * kills the agent's process group before it propagates, so a failed open leaves
 * no process behind; the caller stops the tool host. Each agent request is
 * bounded by initializeTimeoutMs (D-c) and by openSignal: close() during open
 * rejects AGENT_SESSION_CLOSED.
 */
import { type McpServer, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
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
import type { ResolvedAcpOptions } from "#src/client/options";
import { preApprovalMeta } from "#src/client/pre-approval";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";
import type { ToolHost } from "#src/client/tool-host";

/** An agent session id longer than this is not trusted (Review Focus 5). */
const MAX_SESSION_ID_CHARS = 512;

export interface OpenedAcp {
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly record: CapabilityRecord;
  readonly agentSessionId: string;
}

interface Opening {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly host: ToolHost | undefined;
}

/** What session/new adds to `cwd`: the tool host's entry and the pre-approval `_meta` (§6.6). */
interface SessionSetup {
  readonly mcpServers: McpServer[];
  readonly _meta?: Record<string, unknown>;
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

export async function openAcpSession(
  options: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  handlers: InboundHandlers,
  launch: LaunchFn,
  host?: ToolHost,
): Promise<OpenedAcp> {
  if (ctx.openSignal.aborted) throw closedDuringOpen(ctx.sessionId);
  const candidate = chooseLaunch(options);
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env: options.env });
  const link = openConnection(launched.target, handlers);
  void launched.exited.then(() =>
    link.close(new NaxError("The ACP agent process exited", "ACP_AGENT_EXITED", { stage: "acp" })),
  );
  try {
    return await establish({ options, ctx, launched, link, host });
  } catch (err) {
    launched.kill();
    link.close();
    throw err;
  }
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

async function establish(o: Opening): Promise<OpenedAcp> {
  const init = await step(
    o,
    "initialize",
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
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
    resume: o.ctx.resume !== undefined,
  });
  if (unmet !== undefined) throw capabilityUnsupported(unmet.capability, unmet.reason);
  const setup = await sessionSetup(o);
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, ...setup }));
  const agentSessionId = created.sessionId;
  if (typeof agentSessionId !== "string" || agentSessionId === "" || agentSessionId.length > MAX_SESSION_ID_CHARS) {
    throw backendUnavailable("session/new returned no usable session id");
  }
  await applyConfig(o, agentSessionId, created.configOptions ?? []);
  await o.ctx.transcriptStore.save(o.ctx.sessionId, initialDoc(o, record, agentSessionId));
  return { launched: o.launched, link: o.link, record, agentSessionId };
}

/** §6.3 step 3: start the tool host when the session has tools; its entry and the pre-approval `_meta` (§6.6). */
async function sessionSetup(o: Opening): Promise<SessionSetup> {
  if (o.host === undefined) return { mcpServers: [] };
  const meta = preApprovalMeta(
    o.options.entry?.preApproval,
    o.ctx.tools.map((tool) => tool.name),
  );
  if (meta === undefined) throw capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools");
  const server = await o.host.start().catch((err: unknown) => {
    throw backendUnavailable(`the tool host could not start: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { mcpServers: [server], _meta: { ...meta } };
}

/** §6.3 step 5: the profile's mode, then the model. Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode !== undefined && !offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const afterMode =
    mode === undefined
      ? offered
      : ((await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }))).configOptions ??
        offered);
  const model = o.options.model;
  if (model === undefined) return;
  const configId = modelOptionId(afterMode, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
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
