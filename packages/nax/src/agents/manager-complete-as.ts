/** Pinned-agent completion dispatch envelope for AgentManager. */

import type { AgentManagerConfig } from "@/config/selectors";
import { NaxError } from "../errors";
import type { IDispatchEventBus } from "../runtime/dispatch-events";
import {
  buildCompleteCallPreamble,
  buildCompleteEvent,
  buildDispatchErrorEvent,
  completeResultProvenance,
  resolveFinalDispatch,
} from "./manager-dispatch";
import type { AgentCompleteOutcome } from "./manager-types";
import type { CompleteOptions, ResolvedCompleteOptions } from "./types";

export interface CompleteAsWithFallbackInput {
  readonly config: AgentManagerConfig;
  readonly dispatchEvents: IDispatchEventBus;
  readonly completeWithFallback: (
    prompt: string,
    options: ResolvedCompleteOptions,
    primaryAgentOverride?: string,
  ) => Promise<AgentCompleteOutcome>;
}

export async function completeAsWithFallback(
  input: CompleteAsWithFallbackInput,
  agentName: string,
  prompt: string,
  options: CompleteOptions,
): Promise<AgentCompleteOutcome> {
  const stage = options.pipelineStage ?? "complete";
  const { resolvedPermissions, augmented, sessionName } = buildCompleteCallPreamble({
    options,
    config: input.config,
    stage,
  });
  const start = Date.now();
  try {
    const outcome = await input.completeWithFallback(prompt, augmented, agentName);
    const event = buildCompleteEvent({
      sessionName,
      prompt,
      response: outcome.result.output,
      ...resolveFinalDispatch(augmented, agentName, outcome),
      stage,
      resolvedPermissions,
      tokenUsage: outcome.result.tokenUsage,
      estimatedCostUsd: outcome.result.estimatedCostUsd,
      exactCostUsd: outcome.result.exactCostUsd,
      profile: input.config.profile,
      startedAt: start,
      sessionId: outcome.result.sessionId,
      ...completeResultProvenance(outcome.result),
    });
    input.dispatchEvents.emitDispatch(event);
    return outcome;
  } catch (err) {
    const errorContext = err instanceof NaxError ? err.context : undefined;
    const dispatch = errorContext as
      | { agentName?: string; modelDef?: ResolvedCompleteOptions["modelDef"]; modelTier?: string }
      | undefined;
    const errEvent = buildDispatchErrorEvent({
      origin: "completeAs",
      agentName: dispatch?.agentName ?? agentName,
      stage,
      error: err,
      prompt,
      resolvedPermissions,
      startedAt: start,
      dispatchOptions: {
        ...options,
        ...(dispatch?.modelDef !== undefined ? { modelDef: dispatch.modelDef } : {}),
        ...(dispatch?.modelTier !== undefined ? { modelTier: dispatch.modelTier } : {}),
      },
    });
    input.dispatchEvents.emitDispatchError(errEvent);
    throw err;
  }
}
