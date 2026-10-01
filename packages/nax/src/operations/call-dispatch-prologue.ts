/**
 * callOpDispatch prologue — the resolution every non-deterministic dispatch
 * performs before branching on `op.kind` (extracted from call.ts for the A6
 * cognitive-complexity drain, docs/plans/STATUS-complexity-drain.md).
 *
 * Holds no state and performs no I/O beyond reading the runtime's config
 * loader — everything here is a pure derivation from `(ctx, op, input)`.
 * Both the complete-kind and run-kind dispatch phases consume the returned
 * `DispatchPrologue` instead of re-deriving these values, so a `kind:"run"`
 * op and a `kind:"complete"` op keep resolving through the exact same code.
 */

import type { ConfiguredModel, ModelsConfig, ModelTier, NaxConfig, ResolvedConfiguredModel } from "../config";
import { DEFAULT_CONFIG, resolveConfiguredModel } from "../config";
import type { PipelineStage } from "../config/permissions";
import { NaxError } from "../errors";
import { composeSections, join } from "../prompts/compose";
import type { SessionRole } from "../session/types";
import type { buildHopCallback } from "./build-hop-callback";
import type { DispatchTarget } from "./call-resolvers";
import {
  newCorrelationId,
  normalizeSelector,
  resolveDispatchTarget,
  resolveOpModel,
  resolveTimeoutMs,
} from "./call-resolvers";
import type { BuildContext, CallContext, DeterministicOperation, Operation } from "./types";

/**
 * The injectable seams callOpDispatch's phases call through. Defined in
 * `call.ts` as `_callOpDeps` (the barrel re-exports it by reference for
 * tests to mutate) and passed BY REFERENCE into the phase functions — never
 * imported back into this file, which would cycle. Phases read `deps.X` at
 * call time, so a test's reassignment before the run is still picked up.
 */
export interface CallOpDeps {
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly buildHopCallback: typeof buildHopCallback;
  readonly readFileOutput: (path: string) => Promise<string | null>;
}

/** Everything the complete-kind and run-kind phases share, resolved once. */
export interface DispatchPrologue<C> {
  /** The op's own config slice — handed to `build`/`parse`/`verify`/`recover`. */
  readonly buildCtx: BuildContext<C>;
  /** The FULL config (`ctx.config` or the runtime's root), not the slice. */
  readonly config: NaxConfig;
  readonly prompt: string;
  readonly timeoutMs: number | undefined;
  readonly callId: string;
  readonly abortSignal: AbortSignal;
  readonly defaultAgent: string;
  readonly effectiveModels: ModelsConfig;
  readonly resolved: ResolvedConfiguredModel;
  readonly effectiveTier: ModelTier;
  readonly sessionRole: SessionRole | undefined;
  readonly target: DispatchTarget;
}

/** Zero dispatches completed — recorded first, thrown after (US-001 AC9). */
export function throwNoDispatch(
  op: { name: string; stage: PipelineStage },
  storyId: string | undefined,
  agentName: string,
): never {
  throw new NaxError(`callOp[${op.name}]: no dispatch completed`, "CALL_OP_NO_DISPATCH", {
    stage: op.stage,
    storyId,
    agentName,
  });
}

/** Abort surfaced at a retry/parse boundary; message names where it fired. */
export function throwAborted(
  op: { name: string; stage: PipelineStage },
  storyId: string | undefined,
  message: string,
): never {
  throw new NaxError(`callOp[${op.name}]: ${message}`, "CALL_OP_ABORTED", { stage: op.stage, storyId });
}

/** Retry budget exhausted; the message differs between the complete and run paths. */
export function throwRetryBudgetExhausted(
  op: { name: string; stage: PipelineStage },
  storyId: string | undefined,
  message: string,
): never {
  throw new NaxError(`callOp[${op.name}]: ${message}`, "CALL_OP_MAX_RETRIES", { stage: op.stage, storyId });
}

/** The non-deterministic members of the Operation union — prologue callers only. */
export type DispatchableOperation<I, O, C> = Exclude<Operation<I, O, C>, DeterministicOperation<I, O, C, never>>;

/** Resolve every value both dispatch kinds need before branching on kind. */
export function buildDispatchPrologue<I, O, C>(
  ctx: CallContext,
  op: DispatchableOperation<I, O, C>,
  input: I,
): DispatchPrologue<C> {
  const selector = normalizeSelector(op.config, op.name);
  const config = ctx.config ?? ctx.runtime.configLoader.current();
  const slicedConfig = selector.select(config);
  const buildCtx = { packageView: ctx.packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);
  const timeoutMs = resolveTimeoutMs(op, input, buildCtx);
  // Stamp a fresh callId per invocation; preserve caller-supplied one (AC7).
  const callId = ctx.callId ?? newCorrelationId();
  // The caller's deadline wins over the run's; see CallContext.signal.
  const abortSignal = ctx.signal ?? ctx.runtime.signal;

  const defaultAgent = ctx.runtime.agentManager.getDefault();
  const opModel: ConfiguredModel = resolveOpModel(op, input, buildCtx) ?? "balanced";
  // resolved.agent honors `{ agent, model }` pin; resolved.modelTier is undefined when a
  // non-tier model is pinned. Fallback to DEFAULT_CONFIG.models when config.models is absent.
  const effectiveModels = config.models ?? DEFAULT_CONFIG.models;
  const resolved = resolveConfiguredModel(effectiveModels, ctx.agentName, opModel, defaultAgent);
  // Pin default: a pinned (tierless) resolution swaps via "balanced" unless the fallback map names a tier (spec §7).
  const effectiveTier = resolved.modelTier ?? "balanced";
  // Sticky slots are keyed per role, so both branches need it before resolving dispatch.
  const sessionRole = ctx.sessionOverride?.role ?? (op.kind === "run" ? op.session.role : undefined);
  // A swap this story already made outranks the op's own resolution — see resolveDispatchTarget (nax#1964).
  const target = resolveDispatchTarget(ctx, resolved, effectiveModels, effectiveTier, defaultAgent, sessionRole);

  return {
    buildCtx,
    config,
    prompt,
    timeoutMs,
    callId,
    abortSignal,
    defaultAgent,
    effectiveModels,
    resolved,
    effectiveTier,
    sessionRole,
    target,
  };
}
