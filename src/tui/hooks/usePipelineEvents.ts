/**
 * usePipelineEvents — stage tracking only.
 *
 * Subscribes to stage:enter on the PipelineEventEmitter (old bus) which
 * is still used by pipeline/runner.ts to emit stage transitions.
 * All story lifecycle state comes from usePipelineBusEvents.
 */

import { useEffect, useState } from "react";
import type { PipelineEventEmitter } from "../../pipeline/events";

export function usePipelineEvents(events: PipelineEventEmitter): { currentStage: string | undefined } {
  const [currentStage, setCurrentStage] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onStageEnter = (stage: string) => setCurrentStage(stage);
    events.on("stage:enter", onStageEnter as Parameters<typeof events.on<"stage:enter">>[1]);
    return () => events.off("stage:enter", onStageEnter as Parameters<typeof events.off<"stage:enter">>[1]);
  }, [events]);

  return { currentStage };
}
