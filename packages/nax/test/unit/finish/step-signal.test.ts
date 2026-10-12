import { describe, expect, test } from "bun:test";
import { STEP_TIMEOUT_MARGIN_MS, stepSignal } from "@/finish/step-signal";

describe("stepSignal (finish A)", () => {
  test("no base, no limit", () => {
    expect(stepSignal(undefined, undefined)).toEqual({ signal: undefined, limit: undefined });
  });
  test("base alone is returned as-is", () => {
    const base = new AbortController().signal;
    expect(stepSignal(base, undefined)).toEqual({ signal: base, limit: undefined });
  });
  test("the combined signal follows the base; the limit part does not", () => {
    const base = new AbortController();
    const { signal, limit } = stepSignal(base.signal, 60_000);
    base.abort();
    expect(signal?.aborted).toBe(true);
    expect(limit?.aborted).toBe(false);
  });
  test("margin is one minute", () => {
    expect(STEP_TIMEOUT_MARGIN_MS).toBe(60_000);
  });
});
