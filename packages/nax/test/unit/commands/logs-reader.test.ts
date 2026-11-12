/**
 * Unit tests for extractRunSummary's story counting.
 *
 * A workflow story closed `complete-gate-open` (a gate still red) logs
 * `story.complete` with `gateOpen: true` and no `success` field. The reader
 * used to default a missing `success` to true and count it passed (#2879).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { extractRunSummary } from "@/commands/logs-reader";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("nax-logs-reader-");
});

afterEach(() => {
  cleanupTempDir(dir);
});

function line(stage: string, data: Record<string, unknown>, second: number): string {
  return JSON.stringify({ timestamp: `2026-11-12T00:00:0${second}.000Z`, level: "info", stage, message: "m", data });
}

async function summarize(lines: readonly string[]) {
  const path = join(dir, "run.jsonl");
  await Bun.write(path, `${lines.join("\n")}\n`);
  return extractRunSummary(path);
}

describe("extractRunSummary — gate-open stories", () => {
  test("counts a gate-open close as gate-open, not passed or failed", async () => {
    const result = await summarize([
      line("run.start", { totalStories: 2 }, 0),
      line("story.complete", { storyId: "US-001" }, 1),
      line("story.complete", { storyId: "US-002", gateOpen: true }, 2),
    ]);

    expect(result).toMatchObject({ total: 2, passed: 1, gateOpen: 1, failed: 0, skipped: 0 });
  });

  test("reports zero gate-open stories for a run with none", async () => {
    const result = await summarize([
      line("run.start", { totalStories: 1 }, 0),
      line("story.complete", { storyId: "US-001" }, 1),
    ]);

    expect(result).toMatchObject({ passed: 1, gateOpen: 0 });
  });
});
