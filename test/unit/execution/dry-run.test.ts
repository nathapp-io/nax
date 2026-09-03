/**
 * handleDryRun — nax#1808.
 *
 * `--dry-run` is documented as "Show plan without executing", and
 * runner-execution.ts states the intent directly: "Skipped under dryRun so
 * planning never mutates the tree." It did neither: it marked every selected
 * story passed, persisted that with savePRD, and the completion phase then
 * auto-committed the result. A subsequent real run saw the stories already
 * passed and silently executed nothing.
 *
 * The two halves are coupled. unified-executor.ts answers `prdDirty: true` by
 * reloading the PRD from disk, so dropping the write while still reporting the
 * PRD dirty would discard the in-memory marks and spin the loop to
 * maxIterations. Not writing and not reporting dirty is what lets the run both
 * terminate and leave the tree alone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makePluginRegistry, makePRD, makeStatusWriter, makeStory, makeTempDir } from "@test/helpers";
import { handleDryRun } from "@/execution/dry-run";
import type { RoutingResult } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";

const ROUTING: RoutingResult = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "test",
};

describe("handleDryRun", () => {
  let tempDir: string;
  let prdPath: string;
  let story: UserStory;
  let prd: PRD;

  beforeEach(() => {
    tempDir = makeTempDir();
    prdPath = join(tempDir, "prd.json");
    story = makeStory({ id: "US-001", status: "pending", passes: false });
    prd = makePRD({ userStories: [story] });
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function run() {
    return handleDryRun({
      prd,
      storiesToExecute: [story],
      routing: ROUTING,
      statusWriter: makeStatusWriter(),
      pluginRegistry: makePluginRegistry(),
      runId: "run-test",
      totalCost: 0,
      iterations: 0,
    });
  }

  test("leaves prd.json on disk untouched", async () => {
    const before = readFileSync(prdPath, "utf8");

    await run();

    expect(readFileSync(prdPath, "utf8")).toBe(before);
  });

  test("reports the PRD clean so the caller does not reload and discard the marks", async () => {
    const result = await run();

    expect(result.prdDirty).toBe(false);
  });

  test("still marks the story passed in memory so the loop terminates", async () => {
    await run();

    expect(prd.userStories[0].status).toBe("passed");
    expect(prd.userStories[0].passes).toBe(true);
  });
});
