import type { PipelineStage } from "@/config/permissions";
import type { AdapterFailure } from "@/context/engine";
import { type ExhaustionOutcome, resolveExhaustion } from "./retry/resolve-exhaustion";
import type { RetryStrategy } from "./retry/types";

export interface ManagerExhaustionOptions {
  readonly failure: AdapterFailure | undefined;
  readonly hopsSoFar: number;
  readonly attempt: number;
  readonly swapWasPossible: boolean;
  readonly agent: string;
  readonly site: "run" | "complete";
  readonly storyId: string | undefined;
  readonly stage: PipelineStage;
  readonly signal: AbortSignal | undefined;
  readonly retryStrategy: RetryStrategy;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onExhausted: (hops: number) => void;
}

/** Bind manager-owned dependencies to the shared terminal failure policy. */
export function resolveManagerExhaustion(options: ManagerExhaustionOptions): Promise<ExhaustionOutcome> {
  return resolveExhaustion({
    failure: options.failure,
    attempt: options.attempt,
    hopsSoFar: options.hopsSoFar,
    swapWasPossible: options.swapWasPossible,
    retryStrategy: options.retryStrategy,
    retryCtx: {
      site: options.site,
      agentName: options.agent,
      stage: options.stage,
      storyId: options.storyId,
    },
    signal: options.signal,
    sleep: options.sleep,
    onExhausted: options.onExhausted,
  });
}
