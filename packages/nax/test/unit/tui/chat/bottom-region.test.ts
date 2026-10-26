import { describe, expect, test } from "bun:test";
import { bottomBlocked, bottomRowsFor, menuRowsFor, viewportActive } from "@/tui/chat/bottom-region";
import { INPUT_RULE_ROWS } from "@/tui/chat/ChatInput";
import { type PickerModel, pickerRows } from "@/tui/chat/Picker";

/** The rows the input's frame and one text row always claim, whatever the bottom budget is. */
const INPUT_MIN_ROWS = INPUT_RULE_ROWS + 1;

/** A mode picker offering no entries: a stand-in whose rows are a known count. */
const PICKER: PickerModel = { kind: "mode", title: "Permission mode", entries: [] };

describe("bottomBlocked", () => {
  test("no ask and no picker leaves the input in charge", () => {
    expect(bottomBlocked(undefined, undefined)).toBe(false);
  });

  test("a picker blocks the input's region", () => {
    expect(bottomBlocked(undefined, PICKER)).toBe(true);
  });
});

describe("viewportActive", () => {
  test("an unlocked screen with no picker keeps the viewport's keys", () => {
    expect(viewportActive(false, undefined)).toBe(true);
  });

  test("a locked screen or a shown picker takes them", () => {
    expect(viewportActive(true, undefined)).toBe(false);
    expect(viewportActive(false, PICKER)).toBe(false);
  });
});

describe("bottomRowsFor", () => {
  test("an ask card's rows are clamped to the budget", () => {
    expect(bottomRowsFor({ ask: 8, picker: undefined, input: 3, budget: 5 })).toBe(5);
  });

  test("an ask card outranks a picker that is also present", () => {
    expect(bottomRowsFor({ ask: 2, picker: PICKER, input: 3, budget: 6 })).toBe(2);
  });

  test("a picker's frame and entries are what it claims", () => {
    expect(bottomRowsFor({ ask: undefined, picker: PICKER, input: 0, budget: 6 })).toBe(
      Math.min(pickerRows(PICKER, 6), 6),
    );
  });

  test("the input's own rows pass through unchanged", () => {
    expect(bottomRowsFor({ ask: undefined, picker: undefined, input: 4, budget: 9 })).toBe(4);
  });
});

describe("menuRowsFor", () => {
  test.each([
    [8, 7, 7 - INPUT_MIN_ROWS],
    [8, 12, 8],
    [3, 7, 3],
    [0, 7, 0],
  ])("%i menu rows in a %i-row budget take %i", (rows, budget, expected) => {
    expect(menuRowsFor({ rows, budget })).toBe(expected);
  });

  test("a budget that cannot hold the input draws no menu at all", () => {
    expect(menuRowsFor({ rows: 8, budget: INPUT_MIN_ROWS })).toBe(0);
    expect(menuRowsFor({ rows: 8, budget: 1 })).toBe(0);
  });

  test("the input and a capped menu fit the budget together", () => {
    const budget = 7;
    expect(INPUT_MIN_ROWS + menuRowsFor({ rows: 8, budget })).toBeLessThanOrEqual(budget);
  });

  test("a menu smaller than the cap is not grown", () => {
    expect(menuRowsFor({ rows: 2, budget: 9 })).toBe(2);
  });
});
