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

import { getSafeLogger } from "../../logger";
import type { PluginRegistry } from "../../plugins";
import type { PipelineEventBus } from "../event-bus";
import type { UnsubscribeFn } from "./hooks";

/**
 * Wire reporter plugin lifecycle events to the event bus.
 *
 * @param bus            - The pipeline event bus
 * @param pluginRegistry - Plugin registry exposing getReporters()
 * @param runId          - Current run ID (for reporter events)
 * @param startTime      - Run start timestamp in ms (for duration calculation)
 * @returns Unsubscribe function
 */
export function wireReporters(
  bus: PipelineEventBus,
  pluginRegistry: PluginRegistry,
  runId: string,
  startTime: number,
): UnsubscribeFn {
  const logger = getSafeLogger();

  const safe = (name: string, fn: () => Promise<void>) => {
    fn().catch((err) => logger?.warn("reporters-subscriber", `Reporter "${name}" error`, { error: String(err) }));
  };

  const unsubs: UnsubscribeFn[] = [];

  // run:started → reporter.onRunStart
  unsubs.push(
    bus.on("run:started", (ev) => {
      safe("onRunStart", async () => {
        const reporters = pluginRegistry.getReporters();
        for (const r of reporters) {
          if (r.onRunStart) {
            try {
              await r.onRunStart({
                runId,
                feature: ev.feature,
                totalStories: ev.totalStories,
                startTime: new Date(startTime).toISOString(),
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
      safe("onStoryComplete(completed)", async () => {
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
      safe("onStoryComplete(failed)", async () => {
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
      safe("onStoryComplete(paused)", async () => {
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

  // run:completed → reporter.onRunEnd
  unsubs.push(
    bus.on("run:completed", (ev) => {
      safe("onRunEnd", async () => {
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
                  skipped: 0,
                  paused: 0,
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
