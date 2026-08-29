/**
 * render-utils.ts — fitScratchBlocks (nax#1757)
 *
 * Both scratch render paths cap their output at a character ceiling. They used
 * to join every block and take `slice(0, max)`, which keeps the HEAD — the
 * oldest entries — and leaves a half-rendered entry at the cut. This helper
 * drops whole entries from the oldest end instead, so what survives a ceiling
 * is always the newest.
 */

import { describe, expect, test } from "bun:test";
import { fitScratchBlocks, SCRATCH_ENTRY_SEPARATOR } from "@/context/engine/render-utils";

const SEP_LEN = SCRATCH_ENTRY_SEPARATOR.length;

describe("fitScratchBlocks", () => {
  test("returns everything joined when it already fits", () => {
    expect(fitScratchBlocks(["aa", "bb", "cc"], 100)).toBe(
      `aa${SCRATCH_ENTRY_SEPARATOR}bb${SCRATCH_ENTRY_SEPARATOR}cc`,
    );
  });

  test("empty input returns an empty string", () => {
    expect(fitScratchBlocks([], 100)).toBe("");
  });

  test("oldest-first input: drops from the head, keeping the newest", () => {
    // Three 10-char blocks; the ceiling admits exactly two (10 + 2 + 10).
    const blocks = ["0".repeat(10), "1".repeat(10), "2".repeat(10)];
    const out = fitScratchBlocks(blocks, 10 + SEP_LEN + 10);
    expect(out).toBe(`${blocks[1]}${SCRATCH_ENTRY_SEPARATOR}${blocks[2]}`);
    expect(out).not.toContain("0000000000");
  });

  test("newest-first input: drops from the tail, keeping the newest", () => {
    // Pull path with `limit`: blocks[0] is the most recent.
    const blocks = ["2".repeat(10), "1".repeat(10), "0".repeat(10)];
    const out = fitScratchBlocks(blocks, 10 + SEP_LEN + 10, true);
    expect(out).toBe(`${blocks[0]}${SCRATCH_ENTRY_SEPARATOR}${blocks[1]}`);
    expect(out).not.toContain("0000000000");
  });

  test("never exceeds the ceiling", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => `${i}`.repeat(50));
    for (const max of [0, 1, 51, 200, 999]) {
      expect(fitScratchBlocks(blocks, max).length).toBeLessThanOrEqual(Math.max(max, 50));
    }
  });

  test("cuts on entry boundaries — no partial block when at least one fits", () => {
    const blocks = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    const out = fitScratchBlocks(blocks, 70);
    for (const part of out.split(SCRATCH_ENTRY_SEPARATOR)) {
      expect(part.length).toBe(30);
    }
  });

  test("a single block over the ceiling degrades to its head rather than vanishing", () => {
    // Otherwise the caller would emit an empty chunk and the newest entry —
    // the one the reader most needs — would disappear entirely.
    const out = fitScratchBlocks(["old", "z".repeat(500)], 100);
    expect(out).toBe("z".repeat(100));
  });

  test("a single over-ceiling block is taken from the newest end when newestFirst", () => {
    const out = fitScratchBlocks(["z".repeat(500), "old"], 100, true);
    expect(out).toBe("z".repeat(100));
  });
});
