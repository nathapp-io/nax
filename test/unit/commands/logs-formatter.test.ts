/**
 * Unit tests for followLogs in src/commands/logs-formatter.ts.
 *
 * These tests drive the new AbortSignal + injectable dependency seam
 * introduced for the "Make follow mode cancellable and observable" story.
 *
 * Pattern: the `followLogs` function accepts an optional `opts` argument
 * with a `signal` and `_deps: Partial<FollowLogsDeps>`. Tests inject an
 * `emit` that captures formatted lines and a `sleep` that controls how
 * the inter-poll loop terminates. The module-level default for `sleep`
 * is `cancellableDelay` from src/utils/bun-deps.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLogs } from "../../../src/commands/logs-formatter";

const TMP_ROOT = join(tmpdir(), "nax-follow-logs-test");

interface Deps {
  emit: (line: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const SAMPLE_ENTRIES = [
  {
    timestamp: "2026-02-27T10:00:00.000Z",
    level: "info",
    stage: "run.start",
    message: "Starting feature",
    data: { runId: "run-001" },
  },
  {
    timestamp: "2026-02-27T10:00:01.000Z",
    level: "info",
    stage: "story.start",
    storyId: "US-001",
    message: "Story start",
    data: { storyId: "US-001" },
  },
  {
    timestamp: "2026-02-27T10:00:02.000Z",
    level: "info",
    stage: "story.start",
    storyId: "US-002",
    message: "Other story",
    data: { storyId: "US-002" },
  },
];

function writeFixture(dir: string, name: string, entries: typeof SAMPLE_ENTRIES): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return path;
}

describe("followLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(TMP_ROOT, `case-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("cancellation", () => {
    test("returns 'cancelled' and emits nothing when signal is already aborted (AC #1)", async () => {
      const fixture = writeFixture(dir, "run.jsonl", SAMPLE_ENTRIES);
      const emitted: string[] = [];
      const deps: Deps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {},
      };

      const controller = new AbortController();
      controller.abort();

      const outcome = await followLogs(
        fixture,
        { json: false, story: undefined, level: undefined },
        { signal: controller.signal, _deps: deps },
      );

      expect(outcome).toBe("cancelled");
      expect(emitted).toEqual([]);
    });

    test("returns 'cancelled' rather than rejecting when injected sleep rejects on first inter-poll wait (AC #2)", async () => {
      const fixture = writeFixture(dir, "run.jsonl", SAMPLE_ENTRIES);
      const deps: Deps = {
        emit: () => {},
        sleep: async () => {
          throw new Error("aborted by test");
        },
      };

      const outcome = await followLogs(
        fixture,
        {},
        { signal: new AbortController().signal, _deps: deps },
      );

      expect(outcome).toBe("cancelled");
    });

    test("emits both pre-existing entries in file order before returning 'cancelled' when first sleep aborts the signal (AC #3)", async () => {
      const fixture = writeFixture(dir, "run.jsonl", SAMPLE_ENTRIES);
      const emitted: string[] = [];
      let sleepCalls = 0;
      const controller = new AbortController();
      const deps: Deps = {
        emit: (line) => emitted.push(line),
        sleep: async (_ms, signal) => {
          sleepCalls++;
          if (sleepCalls === 1 && signal && !signal.aborted) {
            controller.abort();
          }
          throw new Error("aborted by test");
        },
      };

      const outcome = await followLogs(fixture, {}, { signal: controller.signal, _deps: deps });

      expect(outcome).toBe("cancelled");
      expect(emitted.length).toBe(3);
      expect(emitted[0]).toContain("run-001");
      expect(emitted[1]).toContain("US-001");
      expect(emitted[2]).toContain("US-002");
    });

    test("emits only the storyId: 'US-001' entry when options.story filters and first sleep aborts the signal (AC #4)", async () => {
      const fixture = writeFixture(dir, "run.jsonl", SAMPLE_ENTRIES);
      const emitted: string[] = [];
      let sleepCalls = 0;
      const controller = new AbortController();
      const deps: Deps = {
        emit: (line) => emitted.push(line),
        sleep: async (_ms, signal) => {
          sleepCalls++;
          if (sleepCalls === 1 && signal && !signal.aborted) {
            controller.abort();
          }
          throw new Error("aborted by test");
        },
      };

      const outcome = await followLogs(
        fixture,
        { story: "US-001" },
        { signal: controller.signal, _deps: deps },
      );

      expect(outcome).toBe("cancelled");
      expect(emitted.length).toBe(1);
      expect(emitted[0]).toContain("US-001");
      expect(emitted[0]).not.toContain("US-002");
    });

    test("returns 'cancelled' when signal is already aborted and no dependency override is supplied (AC #5)", async () => {
      const fixture = writeFixture(dir, "run.jsonl", SAMPLE_ENTRIES);
      const controller = new AbortController();
      controller.abort();

      const outcome = await followLogs(fixture, {}, { signal: controller.signal });

      expect(outcome).toBe("cancelled");
    });
  });
});
