/**
 * Unit tests for followLogs byte-offset tailing (US-002).
 *
 * Mirrors `logs.test.ts` for the AC set introduced by US-002 — the byte-aligned
 * incremental read, the `readRange` injectable seam, in-place-truncation
 * resynchronisation, exactly-once emissions, and partial-line continuation.
 *
 * Pattern: tests inject a controllable `sleep` (drives "one poll per call") and a
 * real `readRange` built on `Bun.file(path).slice(start).text()`. Tests wait on
 * the observable side effect (emitted[] or readRangeCalls[]) via `waitForCondition`
 * before aborting — never on a fixed-duration timer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForCondition, withTimeout } from "@test/helpers";
import { type FollowLogsDeps, followLogs } from "../../../src/commands/logs";

describe("--follow mode byte-offset tailing (US-002)", () => {
  let followDir: string;

  beforeEach(() => {
    followDir = makeTempDir("nax-logs-follow-byte-");
  });

  afterEach(() => {
    cleanupTempDir(followDir);
  });

  function makeEntry(message: string, storyId = "US-001"): Record<string, unknown> {
    return {
      timestamp: "2026-02-27T10:00:00.000Z",
      level: "info",
      stage: "test",
      storyId,
      message,
      data: {},
    };
  }

  function encodeLine(entry: Record<string, unknown>): Buffer {
    return Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
  }

  async function realSize(filePath: string): Promise<number> {
    return (await Bun.file(filePath).stat()).size;
  }

  async function writeInitial(filePath: string, entry: Record<string, unknown>): Promise<void> {
    await Bun.write(filePath, encodeLine(entry));
  }

  async function appendEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
    appendFileSync(filePath, encodeLine(entry));
  }

  async function rewriteShorter(filePath: string, entry: Record<string, unknown>): Promise<void> {
    await Bun.write(filePath, encodeLine(entry));
  }

  test("emits appended entry intact when preceding message contains three ✓ characters (AC #1)", async () => {
    const filePath = join(followDir, "run.jsonl");
    await writeInitial(filePath, makeEntry("✓ ✓ ✓"));
    const appended = makeEntry("appended entry");

    const emitted: string[] = [];
    let appendedOnce = false;
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        if (!appendedOnce) {
          await appendEntry(filePath, appended);
          appendedOnce = true;
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until the appended entry has been emitted (observable side effect).
    try {
      await waitForCondition(() => emitted.some((l) => l.includes("appended entry")), 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    // Pre-existing entry emitted once on initial read; appended entry emitted
    // once on poll. The byte-aligned read must NOT silently drop the append.
    expect(emitted.length).toBe(2);
    expect(emitted[0]).toContain("✓ ✓ ✓");
    expect(emitted[1]).toContain("appended entry");
  });

  test("emits three successive ✓-containing entries across three polls in append order (AC #2)", async () => {
    const filePath = join(followDir, "run.jsonl");
    await writeInitial(filePath, makeEntry("seed ✓"));

    const appended = [makeEntry("first ✓"), makeEntry("second ✓"), makeEntry("third ✓")];
    let sleepCalls = 0;

    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        if (sleepCalls < appended.length) {
          await appendEntry(filePath, appended[sleepCalls]);
        }
        sleepCalls++;
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until all three appended entries have been emitted.
    try {
      await waitForCondition(
        () =>
          emitted.some((l) => l.includes("first ✓")) &&
          emitted.some((l) => l.includes("second ✓")) &&
          emitted.some((l) => l.includes("third ✓")),
        1000,
        5,
      );
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    expect(sleepCalls).toBeGreaterThanOrEqual(3);
    // Each appended ✓ entry must be emitted exactly once and in append order.
    const firstIdx = emitted.findIndex((l) => l.includes("first ✓"));
    const secondIdx = emitted.findIndex((l) => l.includes("second ✓"));
    const thirdIdx = emitted.findIndex((l) => l.includes("third ✓"));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
    // Each appended entry appears exactly once (no double-emit on re-poll).
    expect(emitted.filter((l) => l.includes("first ✓")).length).toBe(1);
    expect(emitted.filter((l) => l.includes("second ✓")).length).toBe(1);
    expect(emitted.filter((l) => l.includes("third ✓")).length).toBe(1);
  });

  test("emits every appended entry exactly once across pre-existing + two appends (AC #3)", async () => {
    const filePath = join(followDir, "run.jsonl");
    await writeInitial(filePath, makeEntry("pre-existing ✓"));

    const appendedA = makeEntry("append A ✓");
    const appendedB = makeEntry("append B ✓");
    let sleepCalls = 0;

    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          await appendEntry(filePath, appendedA);
        } else if (sleepCalls === 2) {
          await appendEntry(filePath, appendedB);
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until both appended entries have been emitted.
    try {
      await waitForCondition(
        () =>
          emitted.some((l) => l.includes("append A ✓")) &&
          emitted.some((l) => l.includes("append B ✓")),
        1000,
        5,
      );
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    const aCount = emitted.filter((l) => l.includes("append A ✓")).length;
    const bCount = emitted.filter((l) => l.includes("append B ✓")).length;
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  test("skips an invalid JSON line between two ✓ entries and emits the later valid entry (AC #4)", async () => {
    const filePath = join(followDir, "run.jsonl");
    await writeInitial(filePath, makeEntry("seed ✓"));

    const validA = makeEntry("valid A ✓");
    const validB = makeEntry("valid B ✓");
    let sleepCalls = 0;

    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          appendFileSync(filePath, encodeLine(validA));
          appendFileSync(filePath, Buffer.from("this is not valid json\n", "utf8"));
          appendFileSync(filePath, encodeLine(validB));
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until the later valid entry has been emitted.
    try {
      await waitForCondition(() => emitted.some((l) => l.includes("valid B ✓")), 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    const aCount = emitted.filter((l) => l.includes("valid A ✓")).length;
    const bCount = emitted.filter((l) => l.includes("valid B ✓")).length;
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  test("resynchronises to the new file size on truncation — content present at resync time is not re-emitted, only later appends are (AC #5)", async () => {
    const filePath = join(followDir, "run.jsonl");
    await writeInitial(filePath, makeEntry("seed ✓ ✓ ✓ ✓ ✓"));

    const truncatedEntry = makeEntry("after-truncation ✓");
    const appendedEntry = makeEntry("post-resync ✓");
    let sleepCalls = 0;

    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          await rewriteShorter(filePath, truncatedEntry);
        } else if (sleepCalls === 2) {
          await appendEntry(filePath, appendedEntry);
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until the post-resync entry has been emitted.
    try {
      await waitForCondition(() => emitted.some((l) => l.includes("post-resync ✓")), 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    // The appended entry after truncation must be emitted exactly once.
    const appendedCount = emitted.filter((l) => l.includes("post-resync ✓")).length;
    expect(appendedCount).toBe(1);

    // The content present in the file at resync time (the truncated
    // entry itself) must NOT be re-emitted — resync jumps to the new
    // file size, it does not re-scan from 0.
    const truncatedCount = emitted.filter((l) => l.includes("after-truncation ✓")).length;
    expect(truncatedCount).toBe(0);
  });

  test("readRange receives start offset equal to bytes already consumed, not 0, on append polls (AC #6)", async () => {
    const filePath = join(followDir, "run.jsonl");
    const initial = makeEntry("seed ✓");
    await writeInitial(filePath, initial);
    const initialSize = encodeLine(initial).length;

    let sleepCalls = 0;
    const readRangeCalls: number[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: () => {},
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          await appendEntry(filePath, makeEntry("append ✓"));
        }
      },
      readRange: async (_path, start) => {
        readRangeCalls.push(start);
        return Buffer.from(await Bun.file(filePath).slice(start).arrayBuffer()).toString(
          "utf8",
        );
      },
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until readRange has been called at least twice (initial + append poll).
    try {
      await waitForCondition(() => readRangeCalls.length >= 2, 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    // The first call (during the initial read) is start=0.
    // The second call (during the append poll) must equal the byte length
    // already consumed — which is the size of the initial file.
    expect(readRangeCalls.length).toBeGreaterThanOrEqual(2);
    expect(readRangeCalls[0]).toBe(0);
    expect(readRangeCalls[1]).toBe(initialSize);
  });

  test("re-reads a partial trailing line on a later poll and emits it once (malformed-line continuation)", async () => {
    const filePath = join(followDir, "run.jsonl");
    writeFileSync(filePath, "");

    const completed = makeEntry("half-completed ✓");
    // Split the entry mid-line — first half has no trailing newline, second half
    // completes the line and adds the newline.
    const splitAt = encodeLine(completed).indexOf(Buffer.from('✓"', "utf8")) + 1;
    const firstHalf = encodeLine(completed).subarray(0, splitAt);
    const secondHalf = encodeLine(completed).subarray(splitAt);

    let sleepCalls = 0;
    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          appendFileSync(filePath, firstHalf);
        } else if (sleepCalls === 2) {
          appendFileSync(filePath, secondHalf);
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    // Wait until the completed entry has been emitted.
    try {
      await waitForCondition(() => emitted.some((l) => l.includes("half-completed ✓")), 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    const count = emitted.filter((l) => l.includes("half-completed ✓")).length;
    expect(count).toBe(1);
  });

  test("emits a complete non-ASCII line and correctly re-reads a partial trailing line in the same poll (byte/UTF-16 domain regression)", async () => {
    const filePath = join(followDir, "run.jsonl");
    writeFileSync(filePath, "");

    // "A" is a complete non-ASCII line; "B" is only partially appended in the
    // same poll — its trailing bytes have no newline yet. A byte-index computed
    // over the whole chunk but sliced against the UTF-16 string would overrun
    // the real newline after "A" and misalign the offset.
    const completeEntry = makeEntry("A ✓ ✓ ✓");
    const partialEntry = makeEntry("B-MUST-APPEAR");
    const completeLine = encodeLine(completeEntry);
    const partialLineFull = encodeLine(partialEntry);
    const partialFirstHalf = partialLineFull.subarray(0, partialLineFull.length - 20);
    const partialSecondHalf = partialLineFull.subarray(partialLineFull.length - 20);

    let sleepCalls = 0;
    const emitted: string[] = [];
    const deps: FollowLogsDeps = {
      size: realSize,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) {
          appendFileSync(filePath, Buffer.concat([completeLine, partialFirstHalf]));
        } else if (sleepCalls === 2) {
          appendFileSync(filePath, partialSecondHalf);
        }
      },
      readRange: async (path, start) =>
        Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
    };
    const controller = new AbortController();

    const follow = withTimeout(
      followLogs(filePath, {}, { signal: controller.signal, _deps: deps }),
      1000,
      "followLogs",
    );
    try {
      await waitForCondition(() => emitted.some((l) => l.includes("B-MUST-APPEAR")), 1000, 5);
    } finally {
      controller.abort();
    }
    await follow.catch(() => {});

    expect(emitted.filter((l) => l.includes("A ✓ ✓ ✓")).length).toBe(1);
    expect(emitted.filter((l) => l.includes("B-MUST-APPEAR")).length).toBe(1);
  });
});