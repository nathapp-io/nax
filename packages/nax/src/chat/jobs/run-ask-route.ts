import type { InteractionRequest } from "@/interaction/types";
import type { ChatJob } from "./job-types";

export const MAX_CONSECUTIVE_AGENT_ASKS = 3;

/** Pure routing policy; chain liveness and streak ownership belong to the registry. */
export function routeRunAsk(input: {
  readonly job: Pick<ChatJob, "chainId">;
  readonly request: InteractionRequest;
  readonly chainActive: boolean;
  readonly agentStreak: number;
}): "human" | "agent" {
  const metadata = input.request.metadata;
  if (
    !input.job.chainId ||
    !input.chainActive ||
    metadata?.safety === "red" ||
    metadata?.trigger === "pre-merge" ||
    metadata?.trigger === "human-review" ||
    input.agentStreak >= MAX_CONSECUTIVE_AGENT_ASKS
  ) {
    return "human";
  }
  return "agent";
}
