/**
 * loadCheckpoints integration tests — exercise the reader against the real
 * filesystem (checkpoint.jsonl on disk) so AC4 (missing file → empty map)
 * and AC2/AC3 of the writer (single newline-terminated line on disk) are
 * verified end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointWriter, loadCheckpoints } from "@/execution";

describe("loadCheckpoints integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-checkpoint-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty Map when checkpoint.jsonl does not exist", async () => {
    const result = await loadCheckpoints(tmpDir);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("returns empty Map when featureDir does not exist", async () => {
    const result = await loadCheckpoints(join(tmpDir, "does-not-exist"));
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("writes via CheckpointWriter produce a file readable by loadCheckpoints", async () => {
    const writer = new CheckpointWriter({
      filePath: join(tmpDir, "checkpoint.jsonl"),
      runId: "run-int-1",
      _deps: {
        append: async (path: string, line: string): Promise<void> => {
          await appendFile(path, line, "utf8");
        },
      },
    });

    await writer.recordGreen("US-001", "test-writer", { headSha: "h1", dirtyDigest: "d1" });
    await writer.recordGreen("US-001", "implementer", { headSha: "h2", dirtyDigest: "d2" });
    await writer.recordGreen("US-002", "test-writer", { headSha: "h3", dirtyDigest: "d3" });

    expect(existsSync(join(tmpDir, "checkpoint.jsonl"))).toBe(true);

    const result = await loadCheckpoints(tmpDir);
    expect(result.size).toBe(2);
    expect(result.get("US-001")?.greenPhases).toEqual(["test-writer", "implementer"]);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
    expect(result.get("US-001")?.tree).toEqual({ headSha: "h2", dirtyDigest: "d2" });
  });
});