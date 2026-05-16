import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import * as debateModule from "@/debate";

function getRaceAgainstAbort(): <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  storyId: string | undefined,
) => Promise<T> {
  const fn = (debateModule as Record<string, unknown>).raceAgainstAbort;
  expect(fn).toBeDefined();
  return fn as <T>(promise: Promise<T>, signal: AbortSignal, storyId: string | undefined) => Promise<T>;
}

describe("raceAgainstAbort", () => {
  test("is re-exported from the debate barrel", () => {
    expect(typeof (debateModule as Record<string, unknown>).raceAgainstAbort).toBe("function");
  });

  test("resolves the wrapped promise when the signal is not aborted", async () => {
    const raceAgainstAbort = getRaceAgainstAbort();
    const controller = new AbortController();

    await expect(raceAgainstAbort(Promise.resolve("done"), controller.signal, "US-855")).resolves.toBe("done");
  });

  test("throws CALL_OP_ABORTED when the signal is already aborted", async () => {
    const raceAgainstAbort = getRaceAgainstAbort();
    const controller = new AbortController();
    controller.abort();

    const result = raceAgainstAbort(Promise.resolve("done"), controller.signal, "US-855");

    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "CALL_OP_ABORTED" });
  });
});
