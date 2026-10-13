/**
 * The endpoint an op WILL dispatch to, read off before the call (nax#2491 P6), so a log line can
 * name the model at the start of a step instead of only in the later agent-call lines.
 *
 * It repeats the first half of dispatch resolution (op model -> `resolveConfiguredModel`) and none of
 * the second (cooldowns, swaps, sticky slots), so it names the PRIMARY endpoint: a call that is swapped
 * mid-flight still logs the model it actually ran on in its own agent-call lines. Fail-open: any
 * resolution error returns undefined, because a log label must never fail a step.
 */
import { DEFAULT_CONFIG, resolveConfiguredModel } from "@/config";
import { normalizeSelector, resolveOpModel } from "./call-resolvers";
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
    const resolved = resolveConfiguredModel(
      config.models ?? DEFAULT_CONFIG.models,
      ctx.agentName,
      selection,
      ctx.runtime.agentManager.getDefault(),
    );
    return { agentName: resolved.agent, model: resolved.modelDef.model };
  } catch {
    return undefined;
  }
}
