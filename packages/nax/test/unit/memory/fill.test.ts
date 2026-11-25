/**
 * US-009 — how full the rendered memory index is.
 *
 * The index is bounded by two caps (`renderMemoryIndex`), so fill is the larger
 * of the byte ratio and the line ratio, measured over the text the host renders.
 * `indexBytes` is the configured `memory.indexBytes`, and "nearly full" is
 * `omitted > 0` or fill at the configured `memory.compact.threshold` — the
 * omitted test first, because an index already dropping entries is full whatever
 * its measured fill says.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryConfig } from "@/config";
import { memoryConfigOf, NaxConfigSchema } from "@/config";
import { memoryIndexFill, memoryNearlyFull } from "@/memory";

/**
 * ASCII text of exactly `bytes` UTF-8 bytes spanning `lines` lines. Only the two
 * counts matter to the measurement, so the shape is the simplest that gives
 * both: one long line, then the newlines that make up the rest.
 */
function indexText(bytes: number, lines: number): string {
  if (bytes === 0 || lines === 0) return "";
  const newlineCount = lines - 1;
  return `${"x".repeat(bytes - newlineCount)}${"\n".repeat(newlineCount)}`;
}

/** A rendered index of `bytes` bytes over `lines` lines, with `omitted` entries left out. */
function renderedIndex(bytes: number, lines: number, omitted = 0) {
  return { text: indexText(bytes, lines), omitted };
}

/** The default resolved memory block (`memory.compact.threshold` 0.8). */
function defaultMemory(): MemoryConfig {
  return memoryConfigOf(NaxConfigSchema.parse({}));
}

/** The default memory block with `memory.compact.threshold` set to `threshold`. */
function memoryWithThreshold(threshold: number): MemoryConfig {
  return memoryConfigOf(NaxConfigSchema.parse({ memory: { compact: { threshold } } }));
}

describe("memoryIndexFill — byte ratio (AC-11)", () => {
  test("AC-11: 12288 bytes over 10 lines with indexBytes 24576 is 0.5", () => {
    expect(memoryIndexFill(renderedIndex(12_288, 10), 24_576)).toBe(0.5);
  });
});

describe("memoryIndexFill — line ratio wins when larger (AC-12)", () => {
  test("AC-12: 150 lines over 1500 bytes with indexBytes 24576 is 0.75", () => {
    expect(memoryIndexFill(renderedIndex(1_500, 150), 24_576)).toBe(0.75);
  });
});

describe("memoryIndexFill — empty index (AC-13)", () => {
  test("AC-13: an empty index is 0", () => {
    expect(memoryIndexFill({ text: "", omitted: 0 }, 24_576)).toBe(0);
  });
});

describe("memoryNearlyFull — default threshold (AC-14..AC-16)", () => {
  test("AC-14: fill 0.85 with nothing omitted is nearly full", () => {
    expect(memoryNearlyFull(renderedIndex(1_500, 170), defaultMemory())).toBe(true);
  });

  test("AC-15: fill exactly 0.8 with nothing omitted is nearly full", () => {
    expect(memoryNearlyFull(renderedIndex(1_500, 160), defaultMemory())).toBe(true);
  });

  test("AC-16: fill 0.5 with nothing omitted is not nearly full", () => {
    expect(memoryNearlyFull(renderedIndex(12_288, 10), defaultMemory())).toBe(false);
  });
});

describe("memoryNearlyFull — omitted entries win (AC-17)", () => {
  test("AC-17: fill 0.5 with 3 entries omitted is nearly full", () => {
    expect(memoryNearlyFull(renderedIndex(12_288, 10, 3), defaultMemory())).toBe(true);
  });
});

describe("memoryNearlyFull — configured threshold (AC-18)", () => {
  test("AC-18: fill 0.6 is nearly full under threshold 0.5", () => {
    expect(memoryNearlyFull(renderedIndex(1_500, 120), memoryWithThreshold(0.5))).toBe(true);
  });
});

describe("memory barrel exports (AC-19)", () => {
  test("AC-19: memoryIndexFill and memoryNearlyFull are importable from @/memory", () => {
    expect(typeof memoryIndexFill).toBe("function");
    expect(typeof memoryNearlyFull).toBe("function");
  });
});
