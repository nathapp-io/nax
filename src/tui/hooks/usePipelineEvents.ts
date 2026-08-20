/**
 * usePipelineEvents — stage tracking for pre-run phases and current stage.
 *
 * Subscribes to stage:enter/stage:exit on the PipelineEventEmitter (old bus)
 * which is still used by pipeline/runner.ts to emit stage transitions.
 * All story lifecycle state comes from usePipelineBusEvents.
 *
 * Pre-run stages (e.g. "acceptance-setup") are tracked as phase rows
 * in the Progress panel; other stages update currentStage for Live Activity.
 */

import type { PipelineEventEmitter } from "@/pipeline/events";
import type { StageResult } from "@/pipeline/types";
import { useEffect, useState } from "react";

/** Status of a pre-run pipeline stage. */
export interface PreRunPhaseState {
  status: "running" | "passed" | "failed";
}

/** Stage names that appear as pre-run phase rows in the Progress panel. */
const PRE_RUN_STAGES = new Set(["acceptance-setup"]);

export function usePipelineEvents(events: PipelineEventEmitter): {
  currentStage: string | undefined;
  preRunPhases: Record<string, PreRunPhaseState>;
} {
  const [currentStage, setCurrentStage] = useState<string | undefined>(undefined);
  const [preRunPhases, setPreRunPhases] = useState<Record<string, PreRunPhaseState>>({});

  useEffect(() => {
    const onStageEnter = (stage: string) => {
      setCurrentStage(stage);
      if (PRE_RUN_STAGES.has(stage)) {
        setPreRunPhases((prev) => ({ ...prev, [stage]: { status: "running" } }));
      }
    };
    const onStageExit = (stage: string, result: StageResult) => {
      if (PRE_RUN_STAGES.has(stage)) {
        setPreRunPhases((prev) => ({
          ...prev,
          [stage]: { status: result.action === "fail" ? "failed" : "passed" },
        }));
      }
    };
    events.on("stage:enter", onStageEnter as Parameters<typeof events.on<"stage:enter">>[1]);
    events.on("stage:exit", onStageExit as Parameters<typeof events.on<"stage:exit">>[1]);
    return () => {
      events.off("stage:enter", onStageEnter as Parameters<typeof events.off<"stage:enter">>[1]);
      events.off("stage:exit", onStageExit as Parameters<typeof events.off<"stage:exit">>[1]);
    };
  }, [events]);

  return { currentStage, preRunPhases };
}
