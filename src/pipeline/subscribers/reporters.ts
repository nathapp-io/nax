// RE-ARCH: keep
/**
 * Reporters Subscriber (ADR-005, Phase 3 US-P3-002)
 *
 * Maps pipeline events to IReporter plugin methods
 * (onRunStart, onStoryComplete, onRunEnd).
 *
 * Design:
 * - Each reporter call is fire-and-forget
 * - Errors in individual reporters are caught and logged
 * - Returns unsubscribe function for cleanup
 */

import { getSafeLogger } from "@/logger";
import type { PipelineEventBus } from "@/pipeline/event-bus";
import type { UnsubscribeFn } from "@/pipeline/subscribers/hooks";
import type { PluginRegistry } from "@/plugins";
import type { IReporter, PhaseCompleteEvent, PhaseStartEvent } from "@/plugins/types";

type ReporterHook = "onRunStart" | "onStoryComplete" | "onRunEnd" | "onPhaseStart" | "onPhaseComplete";

async function fanOutReporters(
  reporters: IReporter[],
  hook: ReporterHook,
  invoke: (reporter: IReporter) => Promise<void> | undefined,
): Promise<void> {
  const logger = getSafeLogger();
  for (const reporter of reporters) {
    try {
      await invoke(reporter);
    } catch (err) {
      try {
        logger?.warn("plugins", `Reporter '${reporter.name}' ${hook} failed`, { error: err });
      } catch {}
    }
  }
}

/**
 * Wire reporter plugin lifecycle events to the event bus.
 *
 * @param bus            - The pipeline event bus
 * @param pluginRegistry - Plugin registry exposing getReporters()
 * @param runId          - Current run ID (for reporter events)
 * @param startTime      - Run start timestamp in ms (for duration calculation)
 * @param projectKey     - Project identity name (`runtime.projectKey`) — the same value
 *                         `claimProjectIdentity` writes as `.identity`'s `name` field, so
 *                         reporters scope telemetry by project without reading that file.
 * @returns Unsubscribe function
 */
export function wireReporters(
  bus: PipelineEventBus,
  pluginRegistry: PluginRegistry,
  runId: string,
  startTime: number,
  projectKey: string,
): UnsubscribeFn {
  const logger = getSafeLogger();

  const safe = (name: string, fn: () => Promise<void>): Promise<void> => {
    return fn()
      .catch((err) => logger?.warn("reporters-subscriber", `Reporter "${name}" error`, { error: String(err) }))
      .catch(() => {});
  };

  const unsubs: UnsubscribeFn[] = [];
  const phaseStart = (event: PhaseStartEvent): Promise<void> =>
    fanOutReporters(pluginRegistry.getReporters(), "onPhaseStart", (reporter) => reporter.onPhaseStart?.(event));
  const phaseComplete = (event: PhaseCompleteEvent): Promise<void> =>
    fanOutReporters(pluginRegistry.getReporters(), "onPhaseComplete", (reporter) => reporter.onPhaseComplete?.(event));

  unsubs.push(
    bus.on("story:step", (ev) =>
      phaseStart({
        runId,
        scope: "story",
        storyId: ev.storyId,
        phase: ev.step,
        startTime: new Date().toISOString(),
      }),
    ),
    bus.on("story:phase:completed", (phaseEvent) =>
      phaseComplete({
        runId,
        scope: "story",
        storyId: phaseEvent.storyId,
        phase: phaseEvent.phase,
        outcome: phaseEvent.outcome,
        durationMs: phaseEvent.durationMs,
        costUsd: phaseEvent.costUsd,
        tier: phaseEvent.tier,
        testStrategy: phaseEvent.testStrategy,
        sessionModel: phaseEvent.sessionModel,
        details: phaseEvent.details,
      }),
    ),
    bus.on("postrun:phase:started", (ev) =>
      phaseStart({
        runId,
        scope: "run",
        phase: ev.phase,
        startTime: new Date().toISOString(),
      }),
    ),
    bus.on("postrun:phase:completed", (phaseEvent) =>
      phaseComplete({
        runId,
        scope: "run",
        phase: phaseEvent.phase,
        outcome: phaseEvent.passed ? "passed" : "failed",
        durationMs: phaseEvent.durationMs ?? 0,
        costUsd: phaseEvent.costUsd,
        details: phaseEvent.details,
      }),
    ),
  );

  // run:started → reporter.onRunStart
  unsubs.push(
    bus.on("run:started", (ev) => {
      return safe("onRunStart", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onRunStart) {
            try {
              await r.onRunStart({
                runId,
                feature: ev.feature,
                totalStories: ev.totalStories,
                startTime: new Date(startTime).toISOString(),
                project: projectKey,
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onRunStart failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  // story:completed → reporter.onStoryComplete(status: "completed")
  unsubs.push(
    bus.on("story:completed", (ev) => {
      return safe("onStoryComplete(completed)", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onStoryComplete) {
            try {
              await r.onStoryComplete({
                runId,
                storyId: ev.storyId,
                status: "completed",
                runElapsedMs: ev.runElapsedMs,
                cost: ev.cost ?? 0,
                tier: ev.modelTier ?? "balanced",
                testStrategy: ev.testStrategy ?? "test-after",
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onStoryComplete failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  // story:failed → reporter.onStoryComplete(status: "failed")
  unsubs.push(
    bus.on("story:failed", (ev) => {
      return safe("onStoryComplete(failed)", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onStoryComplete) {
            try {
              await r.onStoryComplete({
                runId,
                storyId: ev.storyId,
                status: "failed",
                runElapsedMs: Date.now() - startTime,
                cost: 0,
                tier: "balanced",
                testStrategy: "test-after",
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onStoryComplete failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  // story:paused → reporter.onStoryComplete(status: "paused")
  unsubs.push(
    bus.on("story:paused", (ev) => {
      return safe("onStoryComplete(paused)", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onStoryComplete) {
            try {
              await r.onStoryComplete({
                runId,
                storyId: ev.storyId,
                status: "paused",
                runElapsedMs: Date.now() - startTime,
                cost: 0,
                tier: "balanced",
                testStrategy: "test-after",
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onStoryComplete failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  // story:escalated → reporter.onEscalation
  unsubs.push(
    bus.on("story:escalated", (ev) => {
      return safe("onEscalation", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onEscalation) {
            try {
              await r.onEscalation({
                runId,
                storyId: ev.storyId,
                fromTier: ev.fromTier,
                toTier: ev.toTier,
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onEscalation failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  // run:completed → reporter.onRunEnd
  unsubs.push(
    bus.on("run:completed", (ev) => {
      return safe("onRunEnd", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onRunEnd) {
            try {
              await r.onRunEnd({
                runId,
                totalDurationMs: Date.now() - startTime,
                totalCost: ev.totalCost ?? 0,
                storySummary: {
                  completed: ev.passedStories,
                  failed: ev.failedStories,
                  skipped: ev.skippedStories,
                  paused: ev.pausedStories,
                },
              });
            } catch (err) {
              logger?.warn("plugins", `Reporter '${r.name}' onRunEnd failed`, { error: err });
            }
          }
        }
      });
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}
