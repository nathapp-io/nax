/**
 * nax's native AgentAdapter (S1 port 2): the full adapter surface nax's
 * registry and manager use, composed from the package-side session adapter
 * and `nativeComplete`. Lives outside `src/agents/native/` because that
 * directory moves into `@nathapp/nax-agent` and `AgentAdapter` stays in nax.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid.
 */

import type { ProviderCatalogOverride } from "@/config/schema-types";
import { NATIVE_AGENT, NativeSessionAdapter, nativeComplete, newSessionKey } from "../native";
import { toSessionModel } from "../session-model-mapping";
import type { AgentSessionAdapter, OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "../session-types";
import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "../types";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

/** The builtin names, used when the adapter is built without config. */
const DEFAULT_TIERS: readonly string[] = ["fast", "balanced", "powerful"];

export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  /** Nothing to spawn. Not a placeholder — the absence is the fact. */
  readonly binary = "";
  readonly capabilities: AgentCapabilities;
  /**
   * Session key for the sessionless `complete()` path, per adapter instance.
   *
   * The agent registry caches one adapter per agent name for its own
   * lifetime, and a registry is built once per runtime — so this key's grain is
   * a run, which is the right one: a run's one-shots share a backend and keep a
   * cache warm, while two concurrent runs stay distinct.
   */
  private readonly oneShotKey = newSessionKey();
  private readonly sessions: Required<AgentSessionAdapter>;

  /**
   * `supportedTiers` comes from config because native's tiers are whatever
   * `models.native` names — arbitrary strings, not the three builtins
   * (ADR-027 section 5). An empty array would be actively wrong: the execution
   * stage clamps an unsupported tier to `supportedTiers[0]`, and with none it
   * logs a tier mismatch on every story. The config-less listing path passes
   * nothing and gets the builtins, matching the approximation the ADR already
   * documents for `getAllAgents`.
   */
  constructor(
    supportedTiers: readonly string[] = DEFAULT_TIERS,
    private readonly catalogOverrides: readonly ProviderCatalogOverride[] = [],
    /** Test seam: the session adapter to compose. Production passes nothing. */
    sessions?: Required<AgentSessionAdapter>,
  ) {
    this.sessions = sessions ?? new NativeSessionAdapter(catalogOverrides);
    this.capabilities = {
      supportedTiers: supportedTiers.length > 0 ? supportedTiers : DEFAULT_TIERS,
      maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
      // Explicitly typed, like AcpAgentAdapter does, rather than relying on
      // inference from a literal array.
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    };
  }

  /**
   * Always true: the native agent runs in-process. There is no binary, so
   * there is nothing to install, and "not installed" would be a false
   * answer to a question about presence.
   *
   * Deliberately NOT delegating to hasCredentials(). Whether a credential
   * exists is a different question, and AgentManager.validateCredentials()
   * is the place that asks it. Conflating them made checkAgentHealth()
   * report "not installed" for something that is always present.
   */
  async isInstalled(): Promise<boolean> {
    return true;
  }

  hasCredentials(): Promise<boolean> {
    return this.sessions.hasCredentials();
  }

  /** Dry-run display shows no process, because there is none. */
  buildCommand(): string[] {
    return [];
  }

  complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    return nativeComplete(
      prompt,
      {
        model: toSessionModel(options.modelDef),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      { catalogOverrides: this.catalogOverrides, sessionKey: this.oneShotKey },
    );
  }

  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return this.sessions.openSession(name, opts);
  }

  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    return this.sessions.sendTurn(handle, prompt, opts);
  }

  closeSession(handle: SessionHandle): Promise<void> {
    return this.sessions.closeSession(handle);
  }

  closePhysicalSession(
    handle: string,
    workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    return this.sessions.closePhysicalSession(handle, workdir, options);
  }
}
