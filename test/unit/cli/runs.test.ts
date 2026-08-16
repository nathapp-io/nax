import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runsListCommand, runsShowCommand } from "@/cli";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

/**
 * Regression suite for the two defects that made `nax runs list` / `nax runs show`
 * non-functional (review 2026-08-11, BUG-01 + BUG-37).
 *
 * Both commands read a run's JSONL log. The events they look for are identified by
 * the entry's `stage`, never its `message` — `run.start`'s message is free text
 * ("Starting feature: …"), so the original `e.message === "run.start"` matched
 * nothing and every run was skipped or rejected as INVALID_RUN_LOG.
 */

const RUN_ID = "run-20260811-120000";

/** A run log shaped exactly like the runner writes one. */
function runLogLines(opts: { complete: boolean }): string {
  const lines: Record<string, unknown>[] = [
    {
      timestamp: "2026-08-11T12:00:00.000Z",
      level: "info",
      stage: "run.start",
      message: "Starting feature: demo [nax test]",
      data: { runId: RUN_ID, feature: "demo", workdir: "/repo" },
    },
    {
      timestamp: "2026-08-11T12:00:01.000Z",
      level: "info",
      stage: "execution",
      message: "story passed",
      data: { storyId: "ST-001" },
    },
  ];

  if (opts.complete) {
    // The completion phase emits SEVERAL `run.complete` entries — retention purges
    // and failure warnings all share the stage. Only the last carries the summary
    // payload, so these decoys must precede it.
    lines.push({
      timestamp: "2026-08-11T12:00:02.000Z",
      level: "info",
      stage: "run.complete",
      message: "Purged stale context manifests",
      data: { purged: 3 },
    });
    lines.push({
      timestamp: "2026-08-11T12:00:03.000Z",
      level: "info",
      stage: "run.complete",
      message: "Feature execution completed",
      data: { runId: RUN_ID, feature: "demo", totalStories: 4, storiesCompleted: 3, totalCost: 1.25 },
    });
  }

  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** Seeds the run log under the OUTPUT dir (~/.nax/<project> in real use), not the workdir. */
async function seedRunLog(outputDir: string, opts: { complete: boolean }): Promise<void> {
  const runsDir = join(outputDir, "features", "demo", "runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${RUN_ID}.jsonl`), runLogLines(opts));
}

/**
 * Capture what the commands emit — both write exclusively through the logger.
 *
 * The `resetLogger()` first is not redundant: `initLogger` THROWS when an instance
 * already exists, and Bun shares one module registry across test files. Without it
 * this suite would fail with "Logger already initialized" — an error about the
 * previous file, not this one — the moment any other test leaves a logger standing.
 * The patch itself cannot leak forward: `resetLogger` discards the instance it is on.
 */
function captureLogger(): { entries: { message: string; data?: Record<string, unknown> }[] } {
  const entries: { message: string; data?: Record<string, unknown> }[] = [];
  resetLogger();
  initLogger({ level: "info", useChalk: false });
  const logger = getLogger();
  const origInfo = logger.info.bind(logger);
  logger.info = ((stage: string, message: string, data?: Record<string, unknown>) => {
    entries.push({ message, data });
    return origInfo(stage, message, data);
  }) as typeof logger.info;
  return { entries };
}

describe("nax runs — event lookup", () => {
  let workdir: string;
  let outputDir: string;

  beforeEach(async () => {
    workdir = await makeTempDir("nax-runs-");
    outputDir = join(workdir, "out");
  });

  afterEach(async () => {
    resetLogger();
    await cleanupTempDir(workdir);
  });

  // BUG-01: `run.start` is the STAGE; its message is "Starting feature: …".
  test("runs show finds the start event and does not reject the log", async () => {
    await seedRunLog(outputDir, { complete: true });
    const { entries } = captureLogger();

    await runsShowCommand({ runId: RUN_ID, feature: "demo", workdir, outputDir });

    expect(entries.some((e) => e.message === `Run: ${RUN_ID}`)).toBe(true);
    expect(entries.find((e) => e.message === `Run: ${RUN_ID}`)?.data?.status).toBe("completed");
  });

  test("runs list reports the run instead of skipping it", async () => {
    await seedRunLog(outputDir, { complete: true });
    const { entries } = captureLogger();

    await runsListCommand({ feature: "demo", workdir, outputDir });

    const row = entries.find((e) => e.message.trim() === RUN_ID);
    expect(row).toBeDefined();
    expect(row?.data?.status).toBe("completed");
  });

  // A crashed or SIGKILLed run leaves a half-written final line. Parsing the file
  // all-or-nothing threw on that line and blanked every valid entry before it —
  // losing the log exactly when it is most needed for diagnosis.
  test("a truncated final line does not blank the entries before it", async () => {
    await seedRunLog(outputDir, { complete: true });
    const logPath = join(outputDir, "features", "demo", "runs", `${RUN_ID}.jsonl`);
    await writeFile(logPath, `${await Bun.file(logPath).text()}{"timestamp":"2026-08-11T12:00:04.000Z","st`);

    const { entries } = captureLogger();
    await runsShowCommand({ runId: RUN_ID, feature: "demo", workdir, outputDir });

    expect(entries.some((e) => e.message === `Run: ${RUN_ID}`)).toBe(true);
    expect(entries.find((e) => e.message === `Run: ${RUN_ID}`)?.data?.status).toBe("completed");
  });

  // The completion phase emits multiple `run.complete` entries. Matching the stage
  // alone takes the FIRST — a purge notice with no summary payload — which reports a
  // completed run with zeroed totals. The summary is identified by its payload.
  test("the summary is read from the completion entry, not an earlier run.complete log", async () => {
    await seedRunLog(outputDir, { complete: true });
    const { entries } = captureLogger();

    await runsListCommand({ feature: "demo", workdir, outputDir });

    const row = entries.find((e) => e.message.trim() === RUN_ID);
    expect(row?.data?.totalStories).toBe(4);
    expect(row?.data?.storiesCompleted).toBe(3);
    expect(row?.data?.totalCost).toBe(1.25);
  });

  test("a run with no completion entry is still listed, as in-progress", async () => {
    await seedRunLog(outputDir, { complete: false });
    const { entries } = captureLogger();

    await runsListCommand({ feature: "demo", workdir, outputDir });

    const row = entries.find((e) => e.message.trim() === RUN_ID);
    expect(row?.data?.status).toBe("in-progress");
    expect(row?.data?.totalStories).toBe(0);
  });
});
