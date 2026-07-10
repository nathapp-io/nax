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

  test("determines the newest runId by lexical string comparison", async () => {
    // Lexical newest: "run-2" > "run-1"
    const a = record("US-001", "test-writer", { runId: "run-1" });
    const b = record("US-001", "implementer", { runId: "run-2" });
    const c = record("US-002", "test-writer", { runId: "run-1" });
    const content = `${a}\n${b}\n${c}\n`;
    const deps = makeReadDep(content);

    const result = await loadCheckpoints("/feature", { _deps: deps });
    const us001 = result.get("US-001");
    expect(us001?.greenPhases).toEqual(["implementer"]);
    expect(result.has("US-002")).toBe(false);
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