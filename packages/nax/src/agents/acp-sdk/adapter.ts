/**
 * AcpSdkAgentAdapter: nax's AgentAdapter over @nathapp/nax-agent-acp (S4b spec
 * §5.1). It drives the backend's S1 adapter itself (D24, B6) with nax's turn
 * loop around it. The live map routes
 * turns and closes from a nax handle id to its session; it is never used to
 * reuse a session, which SessionManager owns (§6.1).
 *
 * complete() is a throwaway session (complete.ts, B3).
 */
import type { OpenSessionOpts, ProtocolIds } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { buildAllowedEnv } from "../shared/env";
import { throwIfAborted } from "../turn";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRunOptions,
  CompleteResult,
  ResolvedCompleteOptions,
  SendTurnOpts,
  SessionHandle,
  TurnResult,
} from "../types";
import { runComplete } from "./complete";
import { type AcpSdkEntry, acpSdkEntry, UNSUPPORTED_ENTRY } from "./entries";
import { _acpSdkDeps, type AcpSdkSession, closeDeadlineMs, createSession, shutdownSession } from "./session";
import { runTurnLoop } from "./turn-loop";

const STAGE = "acp-sdk";

function notifyEstablished(opts: OpenSessionOpts, protocolIds: ProtocolIds | undefined, name: string): void {
  if (opts.onSessionEstablished === undefined || protocolIds === undefined) return;
  try {
    opts.onSessionEstablished(protocolIds, name);
  } catch (err) {
    getSafeLogger()?.warn(STAGE, "onSessionEstablished callback threw; continuing", {
      sessionName: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class AcpSdkAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  /** The agent's own CLI, for display and `nax agents`' version probe (D2-f). */
  readonly binary: string;
  readonly capabilities: AgentCapabilities;
  private readonly entry: AcpSdkEntry | undefined;
  private readonly live = new Map<string, AcpSdkSession>();

  constructor(agentName: string) {
    this.entry = acpSdkEntry(agentName);
    const shown = this.entry ?? UNSUPPORTED_ENTRY;
    this.name = agentName;
    this.displayName = shown.displayName;
    this.binary = shown.binary;
    this.capabilities = {
      supportedTiers: shown.supportedTiers,
      maxContextTokens: shown.maxContextTokens,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["tdd", "review", "refactor"]),
    };
  }

  /** True when nax-agent-acp finds a launch candidate for the agent, the npx fallback included (spec §6.8). */
  async isInstalled(): Promise<boolean> {
    return this.entry !== undefined && _acpSdkDeps.launchCandidateKind(this.entry.agent) !== undefined;
  }

  /** Spec §6.8, D3-k: the run's install check warns when only the npx fallback resolves. */
  launchNote(): string | undefined {
    if (this.entry === undefined || _acpSdkDeps.launchCandidateKind(this.entry.agent) !== "npx") return undefined;
    return `Only the npx fallback can launch ACP agent "${this.name}"; the first run downloads it inside the startup deadline`;
  }

  /** Display only: the backend resolves the launch command per session. */
  buildCommand(): string[] {
    return ["acp", this.name];
  }

  buildAllowedEnv(options?: AgentRunOptions): Record<string, string | undefined> {
    return buildAllowedEnv(options?.modelDef.env === undefined ? undefined : { modelEnv: options.modelDef.env });
  }

  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    const entry = this.requireEntry(options.sessionName ?? "complete");
    throwIfAborted(options.signal, "Run aborted — shutdown in progress");
    await this.requireWorkdir(options.sessionName ?? "complete", options.workdir);
    return runComplete(this.name, entry.agent, prompt, options);
  }

  async openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    const entry = this.requireEntry(name);
    throwIfAborted(opts.signal, "Run aborted — shutdown in progress");
    await this.requireWorkdir(name, opts.workdir);
    const stale = this.live.get(name);
    if (stale !== undefined) {
      getSafeLogger()?.warn(STAGE, "An ACP session of this name was still open; closing it before opening fresh", {
        sessionName: name,
      });
      await this.closeSession(stale.handle);
    }
    getSafeLogger()?.info(STAGE, "Opening ACP session", {
      sessionName: name,
      agent: entry.agent,
      permission: opts.resolvedPermissions.mode,
    });
    const session = await createSession(name, entry.agent, opts);
    this.live.set(name, session);
    notifyEstablished(opts, session.handle.protocolIds, name);
    return session.handle;
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    return runTurnLoop(this.sessionFor(handle.id), prompt, opts);
  }

  async closeSession(handle: SessionHandle): Promise<void> {
    const session = this.live.get(handle.id);
    if (session === undefined) return;
    this.live.delete(handle.id);
    await shutdownSession(session, { waitMs: closeDeadlineMs(session.opts) });
  }

  /** Closes a session this adapter opened; any other handle is a no-op (spec §11 item 6). */
  async closePhysicalSession(
    handle: string,
    _workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const session = this.live.get(handle);
    if (session === undefined) {
      getSafeLogger()?.debug(STAGE, "No live ACP session for this handle; nothing to close", { sessionName: handle });
      return;
    }
    this.live.delete(handle);
    await shutdownSession(session, {
      waitMs: closeDeadlineMs(session.opts),
      force: options?.force === true,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private requireEntry(sessionName: string): AcpSdkEntry {
    if (this.entry !== undefined) return this.entry;
    throw new NaxError(
      `Agent "${this.name}" has no ACP launcher, so it cannot run as an ACP agent`,
      "ACP_AGENT_UNSUPPORTED",
      { stage: STAGE, agentName: this.name, sessionName },
    );
  }

  private async requireWorkdir(sessionName: string, workdir: string): Promise<void> {
    if (await _acpSdkDeps.cwdExists(workdir)) return;
    throw new NaxError(
      `[acp-sdk] Session cwd does not exist: ${workdir} — cannot start agent "${this.name}". If this is a new package for the feature, ensure its directory is created before the run.`,
      "SESSION_CWD_MISSING",
      { stage: "open-session", agentName: this.name, cwd: workdir, sessionName },
    );
  }

  private sessionFor(id: string): AcpSdkSession {
    const session = this.live.get(id);
    if (session !== undefined) return session;
    throw new NaxError(`No open ACP session "${id}" on this adapter`, "ACP_SDK_SESSION_NOT_OPEN", {
      stage: STAGE,
      sessionName: id,
    });
  }
}
