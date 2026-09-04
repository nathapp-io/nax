/**
 * The native AgentAdapter: one-shot completions over nax-ai, no subprocess.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid. openSession/closeSession are
 * transcript-file bookkeeping, and sendTurn maps the native turn loop
 * (session/turn-loop.ts) over complete() — nax owns the conversation because
 * nax-ai's client is stateless (ADR-027 section 10, ADR-028).
 */

import type { OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import { createTurnDeadline } from "../turn-deadline";
import { anyAmbientCredential, listStoredProviders } from "./auth";
import { getNativeClient } from "./client";
import { toAdapterFailure } from "./errors";
import { estimateCostUsd, NATIVE_AGENT, parseNativeModel, toNaxTokenUsage } from "./models";
import { closeNativeSession, nativeSessionTimeouts, openNativeSession } from "./session/session";
import { runNativeTurn } from "./session/turn-loop";
import { nativeSessionId, newSessionKey } from "./session-affinity";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } } {
  return typeof err === "object" && err !== null && "protocolError" in err;
}

/** The builtin names, used when the adapter is built without config. */
const DEFAULT_TIERS: readonly string[] = ["fast", "balanced", "powerful"];

/** Test seam, following the _clientDeps precedent. */
export const _adapterDeps = { listStoredProviders, anyAmbientCredential };

export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  /** Nothing to spawn. Not a placeholder — the absence is the fact. */
  readonly binary = "";
  readonly capabilities: AgentCapabilities;

  /**
   * `supportedTiers` comes from config because native's tiers are whatever
   * `models.native` names — arbitrary strings, not the three builtins
   * (ADR-027 section 5). An empty array would be actively wrong: the execution
   * stage clamps an unsupported tier to `supportedTiers[0]`, and with none it
   * logs a tier mismatch on every story. The config-less listing path passes
   * nothing and gets the builtins, matching the approximation the ADR already
   * documents for `getAllAgents`.
   */
  /**
   * Session key for the sessionless `complete()` path, per adapter instance.
   *
   * The agent registry caches one adapter per agent name for its own
   * lifetime, and a registry is built once per runtime — so this key's grain is
   * a run, which is the right one: a run's one-shots share a backend and keep a
   * cache warm, while two concurrent runs stay distinct.
   */
  private readonly oneShotKey = newSessionKey();

  constructor(supportedTiers: readonly string[] = DEFAULT_TIERS) {
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

  /**
   * Can this agent authenticate to at least one provider?
   *
   * Deliberately not "is the provider this run needs satisfied": this method
   * takes no provider, and it cannot get one. The registry receives the
   * manager's config slice, and agentManagerConfigSelector excludes
   * config.models by design (ADR-019). Probing every provider for a specific
   * answer is not an alternative either — pi's resolve() may execute commands.
   *
   * So this prunes exactly one case: nothing stored anywhere and nothing
   * ambient. That is the real failure — a user who has never run
   * `nax auth login` and has no provider environment variables — and every
   * native call is going to fail anyway. A wrong-provider credential still
   * surfaces per request, through the typed mapping from ProtocolError.kind
   * "auth" to availability / fail-auth.
   *
   * Errors resolve to true. Pruning an agent that would have worked kills a
   * run; the opposite costs one request-time error that is already handled.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      if ((await _adapterDeps.listStoredProviders()).length > 0) return true;
      return await _adapterDeps.anyAmbientCredential();
    } catch {
      return true;
    }
  }

  /** Dry-run display shows no process, because there is none. */
  buildCommand(): string[] {
    return [];
  }

  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    // modelDef.provider is deliberately ignored. resolveModel() INFERS it from
    // the model name for string entries ("claude..." -> anthropic, else
    // "unknown"), so it is a guess rather than configuration — and routing a
    // billed call on a guess is what the protocol gate exists to prevent. The
    // string is the only source of truth.
    const { provider, model } = parseNativeModel(options.modelDef.model);
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);

    const controller = new AbortController();
    const timer = options.timeoutMs !== undefined ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

    try {
      const result = await client.complete(resolved, {
        messages: [{ role: "user", content: prompt }],
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        sessionId: nativeSessionId(this.oneShotKey),
        signal: controller.signal,
      });

      const tokenUsage = toNaxTokenUsage(result.usage);
      const catalog = client.pricing(resolved);
      const rates = options.modelDef.pricing ?? {
        inputPer1M: catalog.input,
        outputPer1M: catalog.output,
      };

      return {
        output: result.text,
        tokenUsage,
        estimatedCostUsd: estimateCostUsd(tokenUsage, rates),
        // exactCostUsd is deliberately unset: nax-ai supplies rates and
        // computes no cost, so nothing here is exact.
      };
    } catch (err) {
      // Returned, not rethrown: rethrowing routes through
      // classifyCompleteException -> parseAgentError, which parses ACP strings
      // and would discard the typed kind nax-ai just gave us.
      if (isProtocolStreamError(err)) {
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          adapterFailure: toAdapterFailure(err.protocolError.kind),
        };
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
    return openNativeSession(name, opts);
  }

  async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
    const { provider, model } = parseNativeModel(handle.modelDef?.model ?? "");
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);
    const catalog = client.pricing(resolved);
    const rates = handle.modelDef?.pricing ?? { inputPer1M: catalog.input, outputPer1M: catalog.output };
    const timeoutSeconds = nativeSessionTimeouts.get(handle.id);
    // Keyed on the session, so every turn of one conversation carries the same
    // id and the provider can keep its cache warm across them.
    const sessionId = nativeSessionId(handle.id);

    // One budget for the whole turn, not one per round-trip. Created here
    // because this is where `timeoutSeconds` is known; consulted by the loop.
    const deadline = createTurnDeadline(timeoutSeconds);

    return runNativeTurn(handle, prompt, opts, {
      deadline,
      complete: async (messages, tools) => {
        // The controller is armed with what is LEFT of the turn, so N
        // round-trips can no longer add up to N x timeoutSeconds. Still
        // combined with any caller-supplied opts.signal via AbortSignal.any so
        // either can end the call.
        const remainingMs = deadline.remainingMs();
        const controller = new AbortController();
        const timer = remainingMs !== undefined ? setTimeout(() => controller.abort(), remainingMs) : undefined;
        const signal =
          opts.signal !== undefined ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

        try {
          const res = await client.complete(resolved, {
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            sessionId,
            signal,
          });
          const usage = toNaxTokenUsage(res.usage);
          return {
            text: res.text,
            ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
            ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
            usage,
            costUsd: estimateCostUsd(usage, rates),
          };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    });
  }

  closeSession(handle: SessionHandle): Promise<void> {
    // The adapter interface has no failure signal, so a close through this path
    // is a clean one. sendTurn keeps the transcript itself when a turn fails.
    return closeNativeSession(handle, false);
  }
}
