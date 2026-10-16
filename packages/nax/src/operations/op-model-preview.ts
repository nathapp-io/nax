/**
 * The endpoint an op WILL dispatch to, read off before the call (nax#2491 P6), so a log line can
 * name the model at the start of a step instead of only in the later agent-call lines.
 *
 * It repeats dispatch resolution up to the point a call starts: the op's model, `resolveConfiguredModel`, then
 * the story's sticky ladder slot (`resolveDispatchTarget`, read-only), so a story that already swapped away
 * from a dead primary names the endpoint it will really use. A swap that happens mid-call is not foreseeable;
 * that call still logs the model it ran on in its own agent-call lines. Fail-open: any
 * resolution error returns undefined, because a log label must never fail a step.
 */
import { resolveStartAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import type { OpEndpoint } from "./call-dispatch-prologue";
import { resolveOpEndpoint } from "./call-dispatch-prologue";
import { normalizeSelector } from "./call-resolvers";
import type { CallContext, Operation } from "./types";

export interface OpModelPreview {
  readonly agentName: string;
  readonly model: string;
}

export function previewOpModel<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): OpModelPreview | undefined {
  if (op.kind === "deterministic") return undefined;
  try {
    const config = ctx.config ?? ctx.runtime.configLoader.current();
    const buildCtx = { packageView: ctx.packageView, config: normalizeSelector(op.config, op.name).select(config) };
    const endpoint = resolveOpEndpoint(ctx, op, input, config, buildCtx);
    const primary: OpModelPreview = { agentName: endpoint.target.agent, model: endpoint.target.modelDef.model };
    // A run-kind dispatch skips an already-unavailable start agent, so the start line has to
    // name the candidate it will really start on rather than the dead primary. Complete-kind
    // dispatch never skips an unavailable primary at start; deterministic ops have no endpoint.
    const fallback = op.kind === "run" ? startCandidatePreview(ctx, config, endpoint) : undefined;
    return fallback ?? primary;
  } catch {
    return undefined;
  }
}

/**
 * The first fallback candidate's endpoint, when it is the one dispatch will start on: a run-kind
 * op whose primary is already unavailable and whose config has fallback enabled.
 *
 * Undefined — leaving the primary preview in place — when fallback is disabled, the primary is
 * still available, or there is no candidate. A candidate's literal model pin is named verbatim;
 * otherwise its own tier resolves the model, and a tier nothing resolves throws (caught by the
 * caller, which is why this is called inside the preview's try block).
 */
function startCandidatePreview(ctx: CallContext, config: NaxConfig, endpoint: OpEndpoint): OpModelPreview | undefined {
  const { target, effectiveModels, effectiveTier, defaultAgent } = endpoint;
  // The same start decision `runWithFallback` makes, so the line and the dispatch cannot drift.
  // No logger: a preview is not a dispatch, so it must not log the fallback start itself.
  const start = resolveStartAgent(
    ctx.runtime.agentManager,
    target.agent,
    config.agent?.fallback?.enabled,
    undefined,
    null,
    {
      tier: effectiveTier,
      model: target.modelDef.model,
    },
  );
  if (start.agent === target.agent && start.tier === undefined && start.model === undefined) return undefined;
  const model =
    start.model ?? resolveModelForAgent(effectiveModels, start.agent, start.tier ?? effectiveTier, defaultAgent).model;
  return { agentName: start.agent, model };
}
