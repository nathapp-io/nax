import { describe, expect, test } from "bun:test";
import { createAbortError, raceWithAbort, throwIfAborted } from "@/agents/turn/abort";

describe("createAbortError", () => {
  test("returns an Error reason as is", () => {
    const reason = new Error("boom");
    const ctl = new AbortController();
    ctl.abort(reason);
    expect(createAbortError(ctl.signal)).toBe(reason);
  });

  test("wraps a non-empty string reason", () => {
    const ctl = new AbortController();
    ctl.abort("shutdown");
    expect(createAbortError(ctl.signal).message).toBe("shutdown");
  });

  test("falls back for an empty or non-string reason, default 'Run aborted'", () => {
    const ctl = new AbortController();
    ctl.abort("");
    expect(createAbortError(ctl.signal, "custom").message).toBe("custom");
    expect(createAbortError(undefined).message).toBe("Run aborted");
  });
});

describe("throwIfAborted", () => {
  test("does nothing without a signal or when not aborted", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  test("throws the abort error when aborted", () => {
    const ctl = new AbortController();
    ctl.abort("stop");
    expect(() => throwIfAborted(ctl.signal)).toThrow("stop");
  });
});

describe("raceWithAbort", () => {
  test("passes the promise through without a signal", async () => {
    expect(await raceWithAbort(Promise.resolve(7))).toBe(7);
  });

  test("rejects at once when the signal is already aborted", async () => {
    // An empty-string reason selects the fallback message; a bare abort() would
    // carry a DOMException reason, which createAbortError returns as is.
    const ctl = new AbortController();
    ctl.abort("");
    await expect(raceWithAbort(new Promise(() => {}), ctl.signal, "fb")).rejects.toThrow("fb");
  });

  test("rejects when the signal aborts before the promise settles", async () => {
    const ctl = new AbortController();
    const raced = raceWithAbort(new Promise(() => {}), ctl.signal, "fb");
    ctl.abort("late");
    await expect(raced).rejects.toThrow("late");
  });

  test("propagates the promise's own rejection", async () => {
    const ctl = new AbortController();
    await expect(raceWithAbort(Promise.reject(new Error("inner")), ctl.signal)).rejects.toThrow("inner");
  });

  test("an abort after resolution has no effect", async () => {
    const ctl = new AbortController();
    expect(await raceWithAbort(Promise.resolve("ok"), ctl.signal)).toBe("ok");
    expect(() => ctl.abort()).not.toThrow();
  });
});
