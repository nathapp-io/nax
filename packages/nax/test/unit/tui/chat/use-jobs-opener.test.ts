import { describe, expect, test } from "bun:test";
import { FRAME_SLACK_ROWS, footerStripHit, JOBS_KEY } from "@/tui/chat/use-jobs-opener";

const GEOMETRY = { x: 61, y: 23, footerRow: 23, columns: 80, rightWidth: 20, stripWidth: 7 };

describe("footerStripHit", () => {
  test("AC-1 hits the first strip column", () => {
    expect(footerStripHit(GEOMETRY)).toBe(true);
  });
  test("AC-2 hits the last strip column", () => {
    expect(footerStripHit({ ...GEOMETRY, x: 67 })).toBe(true);
  });
  test.each([60, 68])("AC-3 misses column %i beside the strip", (x) => {
    expect(footerStripHit({ ...GEOMETRY, x })).toBe(false);
  });
  test("AC-4 misses another row", () => {
    expect(footerStripHit({ ...GEOMETRY, y: 22 })).toBe(false);
  });
  test("AC-5 misses every column when no strip is drawn", () => {
    for (let x = 1; x <= GEOMETRY.columns; x += 1) {
      expect(footerStripHit({ ...GEOMETRY, x, stripWidth: 0 })).toBe(false);
    }
  });
});

describe("constants", () => {
  test("the opener key and frame slack are the documented values", () => {
    expect(JOBS_KEY).toBe("g");
    expect(FRAME_SLACK_ROWS).toBe(1);
  });
});
