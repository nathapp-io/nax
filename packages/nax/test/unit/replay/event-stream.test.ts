/**
 * replay event ingestion — incremental JSONL reads (US-006)
 *
 * AC-5:  nonregular files and symlinks are not streamed.
 * AC-6:  records split across read chunks (including a final line with no
 *        newline) reconstruct as whole records, keeping invalid-record handling.
 * AC-7:  a replay log path that is a symlink or nonregular file is reported
 *        instead of being streamed.
 *
 * Every case drives the real reader with a small `chunkBytes`, so a record that
 * straddles a read boundary is exercised without a huge fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { LogEntry } from "@/logger/types";
import { ingestReplayLog, readReplayEvents, storyInputs } from "@/replay";

function record(storyId: string, message: string, extra: Partial<LogEntry> = {}): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    stage: "story-orchestrator",
    storyId,
    message,
    ...extra,
  });
}

function writeLog(dir: string, name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"));
  return path;
}

function expectRefusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the log reader to refuse the path, but it returned normally");
}

describe("ingestReplayLog — AC6: records split across read chunks", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-");
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC6: one record spread over many chunks reconstructs as a single whole record", () => {
    const line = record("US-001", "Phase passed: implementer");
    const path = writeLog(dir, "split.jsonl", [`${line}\n`]);

    const index = ingestReplayLog(path, { chunkBytes: 7 });

    expect(index.recordsInspected).toBe(1);
    expect(storyInputs(index, "US-001").phases).toEqual([{ name: "implementer", status: "pass" }]);
  });

  test("AC6: a final line with no trailing newline is still ingested", () => {
    const first = record("US-001", "Phase passed: test-writer");
    const second = record("US-001", "Phase passed: implementer");
    const path = writeLog(dir, "no-newline.jsonl", [first, second]);

    const index = ingestReplayLog(path, { chunkBytes: 11 });

    expect(index.recordsInspected).toBe(2);
    expect(storyInputs(index, "US-001").phases).toEqual([
      { name: "test-writer", status: "pass" },
      { name: "implementer", status: "pass" },
    ]);
  });

  test("AC6: records stay in log order when each straddles a chunk boundary", () => {
    const path = writeLog(dir, "order.jsonl", [
      record("US-002", "Phase passed: test-writer"),
      record("US-001", "Phase failed: implementer"),
      record("US-002", "Phase failed: full-suite-gate"),
    ]);

    const index = ingestReplayLog(path, { chunkBytes: 13 });

    expect(storyInputs(index, "US-002").phases).toEqual([
      { name: "test-writer", status: "pass" },
      { name: "full-suite-gate", status: "fail" },
    ]);
    expect(storyInputs(index, "US-001").phases).toEqual([{ name: "implementer", status: "fail" }]);
  });

  test("AC6: a multi-byte character split across chunks decodes intact", () => {
    const path = writeLog(dir, "utf8.jsonl", [`${record("US-001", "Phase passed: implémenter→gate")}\n`]);

    const index = ingestReplayLog(path, { chunkBytes: 3 });

    expect(storyInputs(index, "US-001").phases).toEqual([{ name: "implémenter→gate", status: "pass" }]);
  });

  test("AC6: blank and malformed records are still skipped, valid ones kept", () => {
    const path = writeLog(dir, "mixed.jsonl", [
      record("US-001", "Phase passed: test-writer"),
      "{not valid json",
      "   ",
      record("US-002", "Phase failed: implementer"),
    ]);

    const index = ingestReplayLog(path, { chunkBytes: 9 });

    expect(index.recordsInspected).toBe(2);
    expect(storyInputs(index, "US-001").phases).toEqual([{ name: "test-writer", status: "pass" }]);
    expect(storyInputs(index, "US-002").phases).toEqual([{ name: "implementer", status: "fail" }]);
    expect([...index.storyIds]).toEqual(["US-001", "US-002"]);
  });

  test("AC6 boundary: an empty file ingests no records", () => {
    const path = writeLog(dir, "empty.jsonl", []);

    const index = ingestReplayLog(path, { chunkBytes: 4 });

    expect(index.recordsInspected).toBe(0);
    expect([...index.storyIds]).toEqual([]);
  });

  test("AC6 boundary: a trailing newline does not produce a phantom record", () => {
    const path = writeLog(dir, "trailing.jsonl", [`${record("US-001", "Phase passed: implementer")}\n`]);

    const index = ingestReplayLog(path, { chunkBytes: 5 });

    expect(index.recordsInspected).toBe(1);
  });
});

describe("ingestReplayLog — AC5: nonregular files and symlinks are not streamed", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-refuse-");
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC5: a directory is refused instead of being streamed", () => {
    const sub = join(dir, "logs-dir");
    mkdirSync(sub);

    const thrown = expectRefusal(() => ingestReplayLog(sub, { chunkBytes: 8 }));

    expect(thrown).toMatchObject({ code: "LOG_NOT_REGULAR_FILE" });
  });

  test("AC5: a symlink is not followed, even when its target holds valid records", () => {
    const target = writeLog(dir, "target.jsonl", [`${record("US-001", "Phase passed: implementer")}\n`]);
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);

    expect(() => ingestReplayLog(link, { chunkBytes: 8 })).toThrow();
  });

  test("AC5 boundary: the same records are readable through their real path", () => {
    const target = writeLog(dir, "target.jsonl", [`${record("US-001", "Phase passed: implementer")}\n`]);

    const index = ingestReplayLog(target, { chunkBytes: 8 });

    expect(index.recordsInspected).toBe(1);
  });
});

describe("readReplayEvents — AC7: symlink or nonregular log path is reported, not streamed", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-report-");
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC7: a symlinked log path is reported through the reader's error path", async () => {
    const target = writeLog(dir, "target.jsonl", [`${record("US-001", "Phase passed: implementer")}\n`]);
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);

    let streamed = true;
    try {
      await readReplayEvents(link, { chunkBytes: 8 });
    } catch {
      streamed = false;
    }

    expect(streamed).toBe(false);
  });

  test("AC7: a nonregular log path is reported with the registered-log error code", async () => {
    const sub = join(dir, "logs-dir");
    mkdirSync(sub);

    let thrown: unknown;
    try {
      await readReplayEvents(sub, { chunkBytes: 8 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({ code: "LOG_NOT_REGULAR_FILE" });
  });

  test("AC7 boundary: a missing log path keeps the existing missing-input handling (empty index)", async () => {
    const index = await readReplayEvents(join(dir, "absent.jsonl"));

    expect(index.recordsInspected).toBe(0);
    expect([...index.storyIds]).toEqual([]);
  });
});
