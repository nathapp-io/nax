/**
 * callOp resolvers — pure helpers extracted from call.ts.
 *
 * These normalise an Operation's declarative fields (model, timeout, retry,
 * config selector) into concrete values, plus two small factories. They hold no
 * state, touch no I/O, and never reference callOp's internals — which is why
 * they can live apart from the ~450-line dispatch function.
 *
 * Split out because call.ts sat at its grandfathered file-size ceiling (628
 * lines against a 600 limit), so the ratchet forbade any growth — blocking
 * unrelated work that needed a single line in the hopCtx literal.
 */

import type { AgentRunOutcome } from "../agents";
import type { AgentFallbackRecord } from "../agents/manager-types";
import { resolveRetryPreset } from "../agents/retry";
import type { RetryPreset, RetryStrategy } from "../agents/retry";
import { pickSelector } from "../config";
import type { ConfigSelector, ConfiguredModel, NaxConfig } from "../config";
import { NaxError } from "../errors";
import type { UserStory } from "../prd";
import type { BuildContext, CallContext, Operation } from "./types";

/** Hard ceiling for injected RetryStrategy instances that may not self-terminate. */
export const MAX_COMPLETE_RETRY_ATTEMPTS = 20;

/** Per-process monotonic counter mixed into newCorrelationId to guarantee uniqueness within a millisecond. */
let correlationSequence = 0;

/**
 * Generates a per-invocation correlation id (≤16 chars, /^[0-9a-z]+-[0-9a-z]+$/).
 * Exported for unit-testing uniqueness and format guarantees.
 *
 * Date.now() alone repeats across many calls made within the same millisecond, so
 * uniqueness cannot rest on randomness alone (36^6 random suffix still collides at
 * n≈10,000 draws via the birthday paradox). A monotonic counter closes that gap.
 */
export function newCorrelationId(): string {
  correlationSequence = (correlationSequence + 1) % 46_656; // 36^3
  const seq = correlationSequence.toString(36).padStart(3, "0");
  const rand = Math.random().toString(36).slice(2, 5);
  return `${Date.now().toString(36)}-${seq}${rand}`;
}

export function normalizeRunOutcome(outcome: AgentRunOutcome): AgentRunOutcome {
  return outcome;
}

export function normalizeSelector<C>(
  s: ConfigSelector<C> | readonly (keyof NaxConfig)[],
  opName: string,
): ConfigSelector<C> {
  if (Array.isArray(s)) {
    return pickSelector(`anonymous:${opName}`, ...(s as readonly (keyof NaxConfig)[])) as unknown as ConfigSelector<C>;
  }
  return s as ConfigSelector<C>;
}

export function resolveOpModel<I, O, C>(
  op: Operation<I, O, C>,
  input: I,
  buildCtx: BuildContext<C>,
): ConfiguredModel | undefined {
  const m = (op as { model?: ConfiguredModel | ((i: I, ctx: BuildContext<C>) => ConfiguredModel | undefined) }).model;
  if (typeof m === "function") return m(input, buildCtx);
  return m;
}

export function resolveTimeoutMs<I, O, C>(
  op: Operation<I, O, C>,
  input: I,
  buildCtx: BuildContext<C>,
): number | undefined {
  const timeoutMs = op.timeoutMs?.(input, buildCtx);
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new NaxError(`callOp[${op.name}]: invalid timeoutMs (${String(timeoutMs)})`, "CALL_OP_INVALID_TIMEOUT", {
      stage: op.stage,
      timeoutMs,
    });
  }
  return timeoutMs;
}

export function resolveOpRetry<I, O, C>(
  op: Operation<I, O, C>,
  input: I,
  buildCtx: BuildContext<C>,
): RetryStrategy | null {
  const retry = (
    op as {
      retry?: RetryPreset | RetryStrategy | ((i: I, ctx: BuildContext<C>) => RetryPreset | RetryStrategy | undefined);
    }
  ).retry;
  if (!retry) return null;
  if (typeof retry === "function") {
    const resolved = retry(input, buildCtx);
    if (!resolved) return null;
    if ("shouldRetry" in resolved) return resolved as RetryStrategy;
    return resolveRetryPreset(resolved as RetryPreset);
  }
  if ("shouldRetry" in retry) return retry as RetryStrategy;
  return resolveRetryPreset(retry as RetryPreset);
}

/**
 * Synthesize a minimal UserStory for callOp use cases that don't carry a real
 * one (CLI ad-hoc calls, debate runners, simple op invocations). Only the `id`
 * field is read by buildHopCallback's active code paths when no context bundle
 * is provided — the other fields are zero-value placeholders.
 *
 * Uses `satisfies` (not `as`) so any future required field on UserStory breaks
 * compile here, forcing an explicit decision rather than silently producing an
 * empty default. If a downstream provider starts reading e.g. `acceptanceCriteria`
 * for these stub stories, that's a bug — the synthesis path shouldn't run for
 * any op that consumes story data beyond `id`.
 */
export function synthesizeStory(storyId: string | undefined): UserStory {
  return {
    id: storyId ?? "",
    title: "",
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  } satisfies UserStory;
}

/**
 * Append the hops a runWithFallback call reported to the run-scoped per-story store.
 *
 * No-ops for ad-hoc calls that carry no storyId (plan, review outside a story, CLI):
 * the store is keyed by story and `deriveRunFallbackAggregates` groups by it, so an
 * unattributable hop has nowhere to go.
 */
export function recordAgentFallbacks(ctx: CallContext, fallbacks: readonly AgentFallbackRecord[]): void {
  if (fallbacks.length === 0 || !ctx.storyId) return;
  const store = ctx.runtime.agentFallbacks;
  const existing = store.get(ctx.storyId);
  if (existing) {
    existing.push(...fallbacks);
    return;
  }
  store.set(ctx.storyId, [...fallbacks]);
}
