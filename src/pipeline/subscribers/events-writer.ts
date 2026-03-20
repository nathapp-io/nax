/**
 * Events Writer Subscriber
 *
 * Appends one JSON line per pipeline lifecycle event to
 * ~/.nax/events/<project>/events.jsonl. Provides a machine-readable
 * signal that nax exited gracefully (run:completed → event=on-complete),
 * fixing watchdog false crash reports.
 *
 * Design:
 * - Best-effort: all writes are wrapped in try/catch; never throws or blocks
 * - Directory is created on first write via mkdir recursive
 * - Returns UnsubscribeFn matching wireHooks/wireReporters pattern
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getSafeLogger } from "../../logger";
import type { PipelineEventBus } from "../event-bus";
import type { UnsubscribeFn } from "./hooks";

interface EventLine {
  ts: string;
  event: string;
  runId: string;
  feature: string;
  project: string;
  storyId?: string;
  data?: object;
}

/**
 * Wire events file writer to the pipeline event bus.
 *
 * Listens to run:started, story:started, story:completed, story:failed,
 * run:completed, run:paused and appends one JSONL entry per event.
 *
 * @param bus     - The pipeline event bus
 * @param feature - Feature name
 * @param runId   - Current run ID
 * @param workdir - Working directory (project name derived via basename)
 * @returns Unsubscribe function
 */
export function wireEventsWriter(
  bus: PipelineEventBus,
  feature: string,
  runId: string,
  workdir: string,
): UnsubscribeFn {
  const logger = getSafeLogger();
  const project = basename(workdir);
  const eventsDir = join(homedir(), ".nax", "events", project);
  const eventsFile = join(eventsDir, "events.jsonl");
  let dirReady = false;

  const write = (line: EventLine): void => {
    (async () => {
      try {
        if (!dirReady) {
          await mkdir(eventsDir, { recursive: true });
          dirReady = true;
        }
        await appendFile(eventsFile, `${JSON.stringify(line)}\n`);
      } catch (err) {
        logger?.warn("events-writer", "Failed to write event line (non-fatal)", {
          event: line.event,
          error: String(err),
        });
      }
    })();
  };

  const unsubs: UnsubscribeFn[] = [];

  unsubs.push(
    bus.on("run:started", (_ev) => {
      write({ ts: new Date().toISOString(), event: "run:started", runId, feature, project });
    }),
  );

  unsubs.push(
    bus.on("story:started", (ev) => {
      write({ ts: new Date().toISOString(), event: "story:started", runId, feature, project, storyId: ev.storyId });
    }),
  );

  unsubs.push(
    bus.on("story:completed", (ev) => {
      write({ ts: new Date().toISOString(), event: "story:completed", runId, feature, project, storyId: ev.storyId });
    }),
  );

  unsubs.push(
    bus.on("story:decomposed", (ev) => {
      write({
        ts: new Date().toISOString(),
        event: "story:decomposed",
        runId,
        feature,
        project,
        storyId: ev.storyId,
        data: { subStoryCount: ev.subStoryCount },
      });
    }),
  );

  unsubs.push(
    bus.on("story:failed", (ev) => {
      write({ ts: new Date().toISOString(), event: "story:failed", runId, feature, project, storyId: ev.storyId });
    }),
  );

  unsubs.push(
    bus.on("run:completed", (_ev) => {
      write({ ts: new Date().toISOString(), event: "on-complete", runId, feature, project });
    }),
  );

  unsubs.push(
    bus.on("run:paused", (ev) => {
      write({
        ts: new Date().toISOString(),
        event: "run:paused",
        runId,
        feature,
        project,
        ...(ev.storyId !== undefined && { storyId: ev.storyId }),
      });
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}
