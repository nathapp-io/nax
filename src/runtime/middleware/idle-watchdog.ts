import type { NaxConfig } from "../../config";
import { getSafeLogger } from "../../logger";
import type { AgentStreamEvent, IAgentStreamEventBus } from "../agent-stream-events";

export interface WatchdogState {
  readonly callId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: string;
  readonly pid?: number;
  startedAt: number;
  lastActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
}

export function attachAgentIdleWatchdog(
  agentStreamEvents: IAgentStreamEventBus,
  controllerRegistry: Map<string, () => Promise<void>>,
  config: NaxConfig,
): () => void {
  // Stub implementation - will be filled in by implementer
  const logger = getSafeLogger();

  const unsubscribe = agentStreamEvents.onAgentStream((event: AgentStreamEvent) => {
    // Stub listener - implement activity tracking and timeout logic
    logger?.debug("idle-watchdog", "Stream event received", { kind: event.kind });
  });

  return () => {
    unsubscribe();
  };
}
