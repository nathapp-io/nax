import { getSafeLogger } from "../../logger";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus } from "../dispatch-events";

export function attachLoggingSubscriber(bus: IDispatchEventBus, runId: string): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    getSafeLogger()?.info("middleware", "Agent call complete", {
      storyId: event.storyId,
      runId,
      agentName: event.agentName,
      kind: event.kind,
      stage: event.stage,
      durationMs: event.durationMs,
    });
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    getSafeLogger()?.warn("middleware", "Agent call failed", {
      storyId: event.storyId,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      durationMs: event.durationMs,
      error: event.errorMessage,
    });
  });

  return () => {
    offDispatch();
    offError();
  };
}
