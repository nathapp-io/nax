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
import { type LadderSlot, ladderSlotKey } from "../agents/ladder-slot";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { RetryPreset, RetryStrategy } from "../agents/retry";
import { resolveRetryPreset } from "../agents/retry";
import type { FallbackTarget } from "../agents/swap-decision";
import type {
  ConfigSelector,
  ConfiguredModel,
  ModelDef,
  ModelsConfig,
  NaxConfig,
  ResolvedConfiguredModel,
} from "../config";
import { pickSelector, resolveModel, resolveModelForAgent } from "../config";
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

/**
 * Record the failure a dispatch reported, for the run-scoped per-story store.
 *
 * A successful dispatch clears an earlier failure so post-run inspects only
 * the terminal operation. Ad-hoc calls have no attributable story state.
 */
export function recordAdapterFailure(
  ctx: CallContext,
  failure: import("../context/engine").AdapterFailure | undefined,
): void {
  if (!ctx.storyId) return;
  if (failure) {
    ctx.runtime.lastAdapterFailure.set(ctx.storyId, failure);
    return;
  }
  ctx.runtime.lastAdapterFailure.delete(ctx.storyId);
}

/**
 * Record the rung a story's slot landed on, so its later ops start there.
 *
 * Only a real swap is recorded: pinning a slot to its primary would add nothing and
 * would freeze a choice nothing had to make.
 */
export function recordLadderSlot(
  ctx: CallContext,
  target: FallbackTarget | undefined,
  depth: number,
  swapped: boolean,
  tier: string | undefined,
  role: string | undefined,
): void {
  if (!swapped || !target || !ctx.storyId) return;
  ctx.runtime.ladderSlots.set(ladderSlotKey(ctx.storyId, tier, ctx.agentName, role), { target, depth });
}

/** The slot this story's role already landed on at this rung, if any. */
export function ladderSlotFor(
  ctx: CallContext,
  tier: string | undefined,
  role: string | undefined,
): LadderSlot | undefined {
  if (!ctx.storyId) return undefined;
  return ctx.runtime.ladderSlots.get(ladderSlotKey(ctx.storyId, tier, ctx.agentName, role));
}

interface FallbackDispatchOutcome {
  readonly fallbacks: readonly AgentFallbackRecord[];
  readonly finalTarget?: FallbackTarget;
  readonly didSwap?: boolean;
  /** Ladder index `finalTarget` landed on. Populated once Task 7 wires the real dispatch outcome. */
  readonly finalDepth?: number;
}

/**
 * Record both sinks a dispatch outcome feeds: the story's swap-hop ledger, and — only
 * when a swap actually happened — the sticky slot this story's later ops of the same
 * role should reuse. Shared by callOp's run-kind and complete-kind branches so neither
 * drifts from the other.
 */
export function recordDispatchOutcome(
  ctx: CallContext,
  outcome: FallbackDispatchOutcome,
  tier: string | undefined,
  role: string | undefined,
): void {
  recordAgentFallbacks(ctx, outcome.fallbacks);
  recordLadderSlot(ctx, outcome.finalTarget, outcome.finalDepth ?? 0, outcome.didSwap === true, tier, role);
}

/** The agent, model, and ladder depth callOp actually dispatches to, once any sticky slot is applied. */
export interface DispatchTarget {
  readonly agent: string;
  readonly modelDef: ModelDef;
  /** Ladder index this dispatch starts from — 0 unless a slot moved it. */
  readonly startDepth: number;
}

/**
 * Decide the agent, model, and ladder depth `callOp` actually dispatches to for this
 * invocation.
 *
 * A sticky slot this story's role already landed on (via `ladderSlotFor`) outranks the
 * op's own resolution (nax#1964) — re-deriving the agent from `ctx.agentName` every op
 * is what sent a story back to a dead primary once it had swapped away. Falls back to
 * `resolved` unchanged at depth 0 when no swap has happened yet at this rung.
 *
 * Called once, before `callOp` branches on `op.kind` — so a `kind:"run"` op and a
 * `kind:"complete"` op of the same story resolve through the exact same sticky lookup
 * rather than two independent copies that could drift.
 */
export function resolveDispatchTarget(
  ctx: CallContext,
  resolved: ResolvedConfiguredModel,
  effectiveModels: ModelsConfig,
  effectiveTier: string,
  defaultAgent: string,
  role: string | undefined,
): DispatchTarget {
  const slot = ladderSlotFor(ctx, resolved.modelTier, role);
  if (!slot) return { agent: resolved.agent, modelDef: resolved.modelDef, startDepth: 0 };
  const { target } = slot;
  const modelDef =
    target.model !== undefined
      ? resolveModel(target.model)
      : resolveModelForAgent(effectiveModels, target.agent, target.tier ?? effectiveTier, defaultAgent);
  return { agent: target.agent, modelDef, startDepth: slot.depth };
}
