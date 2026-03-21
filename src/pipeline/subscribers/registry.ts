/**
 * Registry Writer Subscriber
 *
 * Creates ~/.nax/runs/<project>-<feature>-<runId>/meta.json on run:started.
 * Provides a persistent record of each run with paths for status and events.
 *
 * Design:
 * - Best-effort: all writes wrapped in try/catch; never throws or blocks
 * - Directory created on first write via mkdir recursive
 * - Written once on run:started, never updated
 * - Returns UnsubscribeFn matching wireHooks/wireEventsWriter pattern
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getSafeLogger } from "../../logger";
import type { PipelineEventBus } from "../event-bus";
import type { UnsubscribeFn } from "./hooks";

export interface MetaJson {
  runId: string;
  project: string;
  feature: string;
  workdir: string;
  statusPath: string;
  eventsDir: string;
  registeredAt: string;
}

/**
 * Wire registry writer to the pipeline event bus.
 *
 * Listens to run:started and writes meta.json to
 * ~/.nax/runs/<project>-<feature>-<runId>/meta.json.
 *
 * @param bus     - The pipeline event bus
 * @param feature - Feature name
 * @param runId   - Current run ID
 * @param workdir - Working directory (project name derived via basename)
 * @returns Unsubscribe function
 */
export function wireRegistry(bus: PipelineEventBus, feature: string, runId: string, workdir: string): UnsubscribeFn {
  const logger = getSafeLogger();
  const project = basename(workdir);
  const runDir = join(homedir(), ".nax", "runs", `${project}-${feature}-${runId}`);
  const metaFile = join(runDir, "meta.json");

  const unsub = bus.on("run:started", (_ev) => {
    (async () => {
      try {
        await mkdir(runDir, { recursive: true });
        const meta: MetaJson = {
          runId,
          project,
          feature,
          workdir,
          statusPath: join(workdir, ".nax", "features", feature, "status.json"),
          eventsDir: join(workdir, ".nax", "features", feature, "runs"),
          registeredAt: new Date().toISOString(),
        };
        await writeFile(metaFile, JSON.stringify(meta, null, 2));
      } catch (err) {
        logger?.warn("registry-writer", "Failed to write meta.json (non-fatal)", {
          path: metaFile,
          error: String(err),
        });
      }
    })();
  });

  return unsub;
}
