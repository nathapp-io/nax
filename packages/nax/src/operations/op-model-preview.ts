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
import { DEFAULT_CONFIG, resolveConfiguredModel } from "@/config";
import { normalizeSelector, resolveDispatchTarget, resolveOpModel } from "./call-resolvers";
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
  try {
    const config = ctx.config ?? ctx.runtime.configLoader.current();
    const buildCtx = { packageView: ctx.packageView, config: normalizeSelector(op.config, op.name).select(config) };
    const selection = resolveOpModel(op, input, buildCtx) ?? "balanced";
    const models = config.models ?? DEFAULT_CONFIG.models;
    const defaultAgent = ctx.runtime.agentManager.getDefault();
    const resolved = resolveConfiguredModel(models, ctx.agentName, selection, defaultAgent);
    const role = ctx.sessionOverride?.role ?? (op.kind === "run" ? op.session.role : undefined);
    const target = resolveDispatchTarget(ctx, resolved, models, resolved.modelTier ?? "balanced", defaultAgent, role);
    return { agentName: target.agent, model: target.modelDef.model };
  } catch {
    return undefined;
  }
}
