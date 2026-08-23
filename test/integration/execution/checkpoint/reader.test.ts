/**
 * loadCheckpoints integration tests — exercise the reader against the real
 * filesystem (checkpoint.jsonl on disk) so AC4 (missing file → empty map)
 * and AC2/AC3 of the writer (single newline-terminated line on disk) are
 * verified end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointWriter, createCheckpointWriter, loadCheckpoints } from "@/execution";

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

  // ---------------------------------------------------------------------
  // Real production I/O path — `createCheckpointWriter`'s `defaultAppend`
  // and `loadCheckpoints`'s `defaultRead` are exercised with no injected
  // `_deps`, unlike every other test in this file (and in
  // test/unit/execution/checkpoint/writer.test.ts / reader.test.ts), which
  // only ever exercise mocked deps.
  // ---------------------------------------------------------------------

  test("createCheckpointWriter's real defaultAppend writes durable, readable JSONL across multiple calls", async () => {
    const filePath = join(tmpDir, "checkpoint.jsonl");
    const writer = createCheckpointWriter(filePath, "run-real-1");

    await writer.recordGreen("US-001", "test-writer", { headSha: "h1", dirtyDigest: "d1" });
    await writer.recordGreen("US-001", "implementer", { headSha: "h2", dirtyDigest: "d2" });
    await writer.recordGreen("US-002", "test-writer", { headSha: "h3", dirtyDigest: "d3" });

    // defaultAppend uses O_APPEND (node:fs/promises.appendFile) directly —
    // no temp-file + rename dance, so no `.tmp` sidecar is ever created.
    expect(existsSync(`${filePath}.tmp`)).toBe(false);

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);

    const result = await loadCheckpoints(tmpDir);
    expect(result.size).toBe(2);
    expect(result.get("US-001")?.greenPhases).toEqual(["test-writer", "implementer"]);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });

  test("a prior run's history survives a fresh writer instance appending on top of it", async () => {
    const filePath = join(tmpDir, "checkpoint.jsonl");

    const firstRunWriter = createCheckpointWriter(filePath, "run-1");
    await firstRunWriter.recordGreen("US-001", "test-writer", { headSha: "h1", dirtyDigest: "d1" });

    // A brand-new writer instance (as happens on process restart / resume)
    // must not truncate the file written by the previous run.
    const secondRunWriter = createCheckpointWriter(filePath, "run-2");
    await secondRunWriter.recordGreen("US-002", "test-writer", { headSha: "h2", dirtyDigest: "d2" });

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);

    // The older run's bytes are physically present on disk (not truncated
    // away by the fresh writer instance).
    const parsedFirst = JSON.parse(lines[0] as string) as { runId: string; storyId: string };
    expect(parsedFirst.runId).toBe("run-1");
    expect(parsedFirst.storyId).toBe("US-001");

    // loadCheckpoints filters per-story (see reader.ts), not by a single
    // file-wide newest runId — US-001's own newest (and only) runId is
    // "run-1", so its checkpoint survives even though a newer runId
    // ("run-2") exists elsewhere in the file for a different story.
    const result = await loadCheckpoints(tmpDir);
    expect(result.get("US-001")?.greenPhases).toEqual(["test-writer"]);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });
});
