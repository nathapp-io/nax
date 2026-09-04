import { describe, expect, test } from "bun:test";
import { createTurnDeadline } from "@/agents/turn-deadline";

describe("turn deadline", () => {
  test("an undefined budget never expires and reports no remainder", () => {
    const d = createTurnDeadline(undefined, () => 0);
    expect(d.expired()).toBe(false);
    expect(d.remainingMs()).toBeUndefined();
  });

  test("counts down from the clock it was created against", () => {
    let now = 1_000;
    const d = createTurnDeadline(10, () => now);
    expect(d.remainingMs()).toBe(10_000);
    now = 4_000;
    expect(d.remainingMs()).toBe(7_000);
    expect(d.expired()).toBe(false);
  });

  test("expires once the budget is spent and never reports a negative remainder", () => {
    let now = 0;
    const d = createTurnDeadline(5, () => now);
    now = 5_000;
    expect(d.expired()).toBe(true);
    now = 9_999;
    expect(d.remainingMs()).toBe(0);
  });
});
