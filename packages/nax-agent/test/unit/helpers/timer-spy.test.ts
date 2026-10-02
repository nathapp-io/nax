import { describe, expect, test } from "bun:test";
import { withTimerSpy } from "#test/helpers/index";

describe("withTimerSpy", () => {
  test("records armed and cleared timers; a cleared timer is not leaked", async () => {
    const spy = await withTimerSpy(async () => {
      const id = setTimeout(() => {}, 60_000);
      clearTimeout(id);
      return "done";
    });
    expect(spy.result).toBe("done");
    expect(spy.armed).toHaveLength(1);
    expect(spy.leaked).toEqual([]);
  });

  test("reports an armed-but-never-cleared timer as leaked", async () => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const spy = await withTimerSpy(async () => {
      id = setTimeout(() => {}, 60_000);
      return 1;
    });
    expect(spy.leaked).toEqual(spy.armed);
    clearTimeout(id);
  });
});
