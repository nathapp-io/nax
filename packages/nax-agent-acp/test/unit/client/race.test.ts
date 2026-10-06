import { describe, expect, test } from "bun:test";
import { race } from "#src/client/race";

const pending = (): Promise<never> => new Promise(() => {});

describe("race: open steps, the cancel grace and the close bound", () => {
  test("a settled promise wins", async () => {
    expect(await race(Promise.resolve(7), { timeoutMs: 1_000 })).toEqual({ kind: "ok", value: 7 });
  });

  test("a rejection is reported, not thrown", async () => {
    const error = new Error("boom");
    expect(await race(Promise.reject(error), {})).toEqual({ kind: "failed", error });
  });

  test("the timeout wins over a pending promise", async () => {
    expect(await race(pending(), { timeoutMs: 5 })).toEqual({ kind: "timeout" });
  });

  test("an abort wins; an already-aborted signal wins at once", async () => {
    const controller = new AbortController();
    const raced = race(pending(), { signal: controller.signal });
    controller.abort();
    expect(await raced).toEqual({ kind: "aborted" });
    expect(await race(pending(), { signal: controller.signal })).toEqual({ kind: "aborted" });
  });

  test("a rejection after the timeout is swallowed, not unhandled", async () => {
    let reject: (error: unknown) => void = () => {};
    const late = new Promise<never>((_, r) => {
      reject = r;
    });
    expect(await race(late, { timeoutMs: 1 })).toEqual({ kind: "timeout" });
    reject(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
