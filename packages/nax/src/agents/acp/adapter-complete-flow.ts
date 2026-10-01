/**
 * ACP adapter's one-shot `complete()` flow.
 *
 * Extracted from `adapter.ts` so the file stays under its 600-line hard
 * limit (file-sizes check, see .claude/rules/project-conventions.md). The
 * flow is unchanged: resolve a rate card once, attempt one call under the
 * primary agent, classify any thrown error through `classifyCompleteError`
 * or `classifyParsedAgentError`, and surface a `CompleteResult` carrying
 * the producer-supplied `pricingSource` / `rates` passengers.
 *
 * US-002: the rate card the adapter resolves propagates onto every result
 * the flow returns, including degraded paths; `rates` is forwarded only
 * when nonzero usage let `priceCall` run (the field is omitted — not zeroed
 * — otherwise).
 */

import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import type { ITokenUsageMapper, RateCard } from "../cost";
import type { AgentAdapter, CompleteResult, ResolvedCompleteOptions } from "../types";
import { CompleteError } from "../types";
import { _fallbackDeps, computeAcpHandle } from "./adapter-lifecycle";
import { deriveTokenUsage } from "./adapter-output";
import type { AcpSession, AcpSessionResponse } from "./adapter-session-types";
import { classifyCompleteError, classifyParsedAgentError } from "./parse-agent-error";
import type { SessionTokenUsage } from "./wire-types";

export async function runCompleteFlow(input: {
  adapter: AgentAdapter;
  prompt: string;
  options: ResolvedCompleteOptions;
  mapper: ITokenUsageMapper<SessionTokenUsage>;
  rateCard: RateCard;
  /**
   * Creates the ACP client. Provided as an injection so this file can be
   * exercised by tests without going through `_acpAdapterDeps.createClient`.
   */
  createClient: typeof import("./adapter-lifecycle")._acpAdapterDeps.createClient;
}): Promise<CompleteResult> {
  const { adapter, prompt, options, mapper, rateCard, createClient } = input;

  const tryOneAgent = async (agentName: string): Promise<CompleteResult> => {
    const cmdStr = `acpx --model ${options.modelDef.model} ${agentName}`;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const client = createClient(
      cmdStr,
      options.workdir,
      timeoutSeconds,
      options.onPidSpawned,
      options.promptRetries,
      options.onPidExited,
      {
        onStreamActivity: options.onStreamActivity,
        onActiveCall: options.onActiveCall,
        trackedSpawnDeadlineMs: options.trackedSpawnDeadlineMs,
        trackedSpawnStartupDeadlineMs: options.trackedSpawnStartupDeadlineMs,
        env: options.modelDef.env,
      },
    );
    await client.start();

    let session: AcpSession | null = null;
    try {
      const completeSessionName =
        options.sessionName ??
        computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
      session = await client.createSession({
        agentName,
        permissionMode: options.resolvedPermissions.mode,
        sessionName: completeSessionName,
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new NaxError("complete() timed out", "AGENT_TIMEOUT", { stage: "acp", timeoutMs })),
          timeoutMs,
        );
      });
      timeoutPromise.catch(() => {});

      let response: AcpSessionResponse;
      try {
        const promptPromise = session.prompt(prompt);
        promptPromise.catch(() => {});
        response = await Promise.race([promptPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.stopReason === "error") {
        if (response.cancelled) {
          // BUG-57: still count tokens burned before the cancel, not zero.
          const { tokenUsage, estimatedCostUsd, rates } = deriveTokenUsage(
            response.cumulative_token_usage,
            rateCard,
            mapper,
          );
          return {
            output: "",
            tokenUsage,
            estimatedCostUsd,
            exactCostUsd: response.exactCostUsd,
            cancelled: true,
            pricingSource: rateCard.source,
            // US-002: forward the rates the producer priced the burned
            // tokens on. Omitted when the nonzero-usage guard skipped
            // pricing, so the field's absence encodes "did not price".
            ...(rates !== undefined ? { rates } : {}),
          };
        }
        // BUG-1: surface parsed error text (retryable preserved as-is). LOW: truncate to 500 chars.
        const errSuffix = response.error ? `: ${response.error.slice(0, 500)}` : "";
        throw new CompleteError(`complete() failed: stop reason is error${errSuffix}`, undefined, response.retryable);
      }

      const text = response.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n")
        .trim();

      let unwrapped = text;
      try {
        const envelope = JSON.parse(text) as Record<string, unknown>;
        if (envelope?.type === "result" && typeof envelope?.result === "string") {
          unwrapped = envelope.result;
        }
      } catch {
        // Not an envelope — use text as-is
      }

      if (!unwrapped) {
        throw new CompleteError("complete() returned empty output");
      }

      const { tokenUsage, estimatedCostUsd, rates } = deriveTokenUsage(
        response.cumulative_token_usage,
        rateCard,
        mapper,
      );
      const exactCostUsd = response.exactCostUsd;

      if (exactCostUsd !== undefined) {
        getSafeLogger()?.info("acp-adapter", "complete() cost", {
          costUsd: exactCostUsd,
          model: options.modelDef.model,
        });
      }

      return {
        output: unwrapped,
        tokenUsage,
        estimatedCostUsd,
        exactCostUsd,
        // US-002: the card's branch, reported rather than re-derived from the
        // model string. A wire-exact cost still outranks it at the cost-row
        // level (the middleware's "wire" branch); the producer does not strip
        // the field.
        pricingSource: rateCard.source,
        // US-002: forward the four per-1M rates the producer priced the
        // call on. Same omission-not-undefined discipline as `pricingSource`:
        // a zeroed `cumulative_token_usage` skips pricing entirely and
        // `rates` stays absent (not set to a zeroed object, not undefined).
        ...(rates !== undefined ? { rates } : {}),
      };
    } finally {
      if (session) {
        // Always force-terminate on the complete-path: each complete() opens its
        // own session and never reuses it, so the queue-owner has no work to amortize.
        // Graceful close leaves the queue-owner alive until TTL — long enough to be
        // orphaned if the user quits nax (or hits Ctrl+C) before the TTL elapses.
        await session.close({ forceTerminate: true }).catch(() => {});
      }
      await client.close().catch(() => {});
    }
  };

  try {
    return await tryOneAgent(adapter.name);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // US-002: both degraded paths carry the card resolved above — zero cost,
    // but still the card this call would have billed on. Without it the cost
    // row falls back to resolvePricingSource(model), a different card.
    if (error instanceof CompleteError) {
      const classified = classifyCompleteError(error, rateCard.source);
      if (classified) return classified;
    }
    const degraded = classifyParsedAgentError(
      _fallbackDeps.parseAgentError(error.message),
      error.message,
      rateCard.source,
    );
    if (degraded) return degraded;
    throw err;
  }
}
