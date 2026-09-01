/**
 * The native AgentAdapter: one-shot completions over nax-ai, no subprocess.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid. Session methods throw until
 * Phase B, which is a storage feature rather than a mapping over complete()
 * (ADR-027 section 10).
 */

import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import { getNativeClient } from "./client";
import { NativeSessionUnsupportedError, toAdapterFailure } from "./errors";
import { estimateCostUsd, NATIVE_AGENT, parseNativeModel, toNaxTokenUsage } from "./models";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } } {
  return typeof err === "object" && err !== null && "protocolError" in err;
}

/** The builtin names, used when the adapter is built without config. */
const DEFAULT_TIERS: readonly string[] = ["fast", "balanced", "powerful"];

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
  constructor(supportedTiers: readonly string[] = DEFAULT_TIERS) {
    this.capabilities = {
      supportedTiers: supportedTiers.length > 0 ? supportedTiers : DEFAULT_TIERS,
      maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
      // Explicitly typed, like AcpAgentAdapter does, rather than relying on
      // inference from a literal array.
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    };
  }

  /** Phase A's probe is client construction, not credential resolution — nax-ai resolves keys at call time (ADR-027 §3). */
  async isInstalled(): Promise<boolean> {
    return this.hasCredentials();
  }

  /**
   * Reports client construction, not credential resolution — so it is
   * effectively always true, and AgentManager.validateCredentials() cannot
   * prune this agent.
   *
   * That is known and deliberate for now. Answering honestly means asking
   * whether a specific provider resolves, and this method takes no provider:
   * the registry receives the manager's config slice, and
   * agentManagerConfigSelector excludes config.models by design under ADR-019.
   * Probing every provider in the catalog is not an alternative, because
   * pi's resolve() may execute commands.
   *
   * The fix belongs to Phase A plan 3, which does model resolution and has a
   * provider legitimately in scope. Until then a missing or bad credential
   * surfaces per provider at request time, through the typed mapping from
   * ProtocolError.kind "auth" to availability / fail-auth.
   *
   * See docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md §6.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      await getNativeClient();
      return true;
    } catch {
      return false;
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

  openSession(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("openSession"));
  }

  sendTurn(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("sendTurn"));
  }

  closeSession(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("closeSession"));
  }
}
