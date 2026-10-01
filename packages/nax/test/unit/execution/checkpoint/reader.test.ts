/**
 * loadCheckpoints unit tests — exercise the reader logic via injected _deps.
 *
 * The reader's behavior (longest-valid-prefix, latest-runId filter, canonical-order grouping,
 * skipping invalid lines) is exercised here through an injected `_deps.read` so torn-line
 * scenarios are reproducible without depending on filesystem races.
 */

import { describe, expect, test } from "bun:test";
import { loadCheckpoints } from "@/execution";

function makeReadDep(content: string) {
  return {
    read: async (_path: string): Promise<string> => content,
  };
}

function record(
  storyId: string,
  phase: string,
  extras: Partial<{ runId: string; ts: number; headSha: string; dirtyDigest: string }> = {},
): string {
  return JSON.stringify({
    storyId,
    phase,
    headSha: "h",
    dirtyDigest: "d",
    runId: "run-1",
    ts: 1700000000000,
    ...extras,
  });
}

describe("loadCheckpoints missing-file path", () => {
  test("returns empty Map and does not throw when read rejects as missing", async () => {
    const deps = {
      read: async (_path: string): Promise<string> => {
        throw new Error("ENOENT");
      },
    };
    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

describe("loadCheckpoints torn-line handling", () => {
  test("drops a torn final line and returns all records from the valid prefix", async () => {
    const valid1 = record("US-001", "test-writer");
    const valid2 = record("US-001", "implementer");
    const torn = '{"storyId":"US-002","phase":"verifier","headSha';
    const content = `${valid1}\n${valid2}\n${torn}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(1);
    const story = result.get("US-001");
    expect(story?.greenPhases).toEqual(["test-writer", "implementer"]);
    expect(result.has("US-002")).toBe(false);
  });

  test("treats a fully-unparseable file as an empty map without throwing", async () => {
    const deps = makeReadDep("{not valid json at all\n{another broken line");
    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(0);
  });
});

describe("loadCheckpoints latest-runId filter", () => {
  test("keeps only records whose runId equals the newest runId present", async () => {
    const oldRecord = record("US-001", "test-writer", { runId: "run-1" });
    const newRecord1 = record("US-001", "implementer", { runId: "run-2" });
    const newRecord2 = record("US-002", "test-writer", { runId: "run-2" });
    const content = `${oldRecord}\n${newRecord1}\n${newRecord2}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });

    // The "test-writer" phase for US-001 was recorded under the old runId,
    // so it must be discarded — only the new-runId phases count.
    const us001 = result.get("US-001");
    expect(us001?.greenPhases).toEqual(["implementer"]);
    expect(result.has("US-002")).toBe(true);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });

  test("determines the newest runId by lexical string comparison, per story", async () => {
    // Lexical newest: "run-2" > "run-1". US-001 advanced to run-2; US-002 has
    // not been touched since run-1. The runId filter is per-story (see
    // module docstring in reader.ts), so US-002's run-1 records must survive
    // even though a newer runId exists elsewhere in the file — a resume
    // involving multiple incomplete stories must resume all of them, not
    // just the one that happens to touch the file first.
    const a = record("US-001", "test-writer", { runId: "run-1" });
    const b = record("US-001", "implementer", { runId: "run-2" });
    const c = record("US-002", "test-writer", { runId: "run-1" });
    const content = `${a}\n${b}\n${c}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    const us001 = result.get("US-001");
    expect(us001?.greenPhases).toEqual(["implementer"]);
    expect(result.has("US-002")).toBe(true);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });

  test("does not let one story's newer runId discard another story's older-runId checkpoints", async () => {
    // Regression for the P1 finding: a resume that re-records US-001's
    // skipped phases under the current run must not cause US-002's
    // still-valid prior-run checkpoints to be dropped when the reader is
    // consulted again for US-002.
    const resumedRunOld = record("US-001", "implementer", { runId: "run-1" });
    const resumedRunReRecorded = record("US-001", "implementer", { runId: "run-2" });
    const otherStoryOld = record("US-002", "test-writer", { runId: "run-1" });
    const content = `${resumedRunOld}\n${otherStoryOld}\n${resumedRunReRecorded}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.get("US-001")?.greenPhases).toEqual(["implementer"]);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });
});

describe("loadCheckpoints grouping by storyId", () => {
  test("groups multiple stories and lists each story's phases in canonical order", async () => {
    const r1 = record("US-001", "verifier", { runId: "run-1" });
    const r2 = record("US-001", "test-writer", { runId: "run-1" });
    const r3 = record("US-002", "implementer", { runId: "run-1" });
    const r4 = record("US-001", "implementer", { runId: "run-1" });
    const content = `${r1}\n${r2}\n${r3}\n${r4}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });

    expect(result.size).toBe(2);
    const us001 = result.get("US-001");
    const us002 = result.get("US-002");
    expect(us001?.greenPhases).toEqual(["test-writer", "implementer", "verifier"]);
    expect(us002?.greenPhases).toEqual(["implementer"]);
  });

  test("includes the tree state captured at the last green record for each story", async () => {
    const r1 = JSON.stringify({
      storyId: "US-001",
      phase: "test-writer",
      headSha: "sha-1",
      dirtyDigest: "dig-1",
      runId: "run-1",
      ts: 1700000000000,
    });
    const r2 = JSON.stringify({
      storyId: "US-001",
      phase: "implementer",
      headSha: "sha-2",
      dirtyDigest: "dig-2",
      runId: "run-1",
      ts: 1700000000001,
    });
    const content = `${r1}\n${r2}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    const us001 = result.get("US-001");
    expect(us001?.tree).toEqual({ headSha: "sha-2", dirtyDigest: "dig-2" });
  });
});

describe("loadCheckpoints invalid-line skip", () => {
  test("skips a well-formed JSON line missing a required field such as phase", async () => {
    const valid = record("US-001", "test-writer", { runId: "run-1" });
    const missingPhase = JSON.stringify({
      storyId: "US-001",
      headSha: "h",
      dirtyDigest: "d",
      runId: "run-1",
      ts: 1700000000000,
    });
    const valid2 = record("US-002", "test-writer", { runId: "run-1" });
    const content = `${valid}\n${missingPhase}\n${valid2}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(2);
    expect(result.get("US-001")?.greenPhases).toEqual(["test-writer"]);
    expect(result.get("US-002")?.greenPhases).toEqual(["test-writer"]);
  });
});

describe("loadCheckpoints type-validated invalid-line skip", () => {
  test("skips a well-formed JSON line whose required field is null instead of a string", async () => {
    const valid = record("US-001", "test-writer");
    // All keys present, but phase is null — would slip past a `in`-only check
    // and poison CANONICAL_ORDER.indexOf() with a -1 result.
    const nullPhase = JSON.stringify({
      storyId: "US-002",
      phase: null,
      headSha: "h",
      dirtyDigest: "d",
      runId: "run-1",
      ts: 1700000000000,
    });
    const content = `${valid}\n${nullPhase}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(1);
    expect(result.has("US-001")).toBe(true);
    expect(result.has("US-002")).toBe(false);
  });

  test("skips a record whose phase is not a known canonical phase", async () => {
    const valid = record("US-001", "test-writer");
    const bogusPhase = JSON.stringify({
      storyId: "US-002",
      phase: "not-a-real-phase",
      headSha: "h",
      dirtyDigest: "d",
      runId: "run-1",
      ts: 1700000000000,
    });
    const content = `${valid}\n${bogusPhase}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(1);
    expect(result.has("US-001")).toBe(true);
    expect(result.has("US-002")).toBe(false);
  });

  test("skips a record whose ts is not a finite number", async () => {
    const valid = record("US-001", "test-writer");
    const badTs = JSON.stringify({
      storyId: "US-002",
      phase: "test-writer",
      headSha: "h",
      dirtyDigest: "d",
      runId: "run-1",
      ts: "not-a-number",
    });
    const content = `${valid}\n${badTs}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(1);
    expect(result.has("US-001")).toBe(true);
    expect(result.has("US-002")).toBe(false);
  });

  test("skips a record whose storyId is an empty string", async () => {
    const valid = record("US-001", "test-writer");
    const emptyStory = JSON.stringify({
      storyId: "",
      phase: "test-writer",
      headSha: "h",
      dirtyDigest: "d",
      runId: "run-1",
      ts: 1700000000000,
    });
    const content = `${valid}\n${emptyStory}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    expect(result.size).toBe(1);
    expect(result.has("US-001")).toBe(true);
    expect(result.has("")).toBe(false);
  });
});
