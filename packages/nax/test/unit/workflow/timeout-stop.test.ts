import { describe, expect, test } from "bun:test";
import { type GateTimeoutRouteInput, gateTimeoutRoute } from "@/workflow/timeout-stop";
import type { GateName, GateRunResult } from "@/workflow/types";

const gate = (...timedOut: GateName[]): GateRunResult => ({ red: true, states: {}, findings: [], timedOut });
const scoped = gate("scoped");
const suite = gate("full-suite");
const empty: GateRunResult = { red: false, states: {}, findings: [] };
const base: GateTimeoutRouteInput = {
  previous: undefined,
  previousSuite: undefined,
  current: undefined,
  currentSuite: undefined,
  baselineTimedOut: false,
};

describe("gateTimeoutRoute", () => {
  test("repeats the same scoped timeout", () =>
    expect(gateTimeoutRoute({ ...base, previous: scoped, current: scoped })).toEqual({
      gates: ["scoped"],
      why: "repeated",
    }));
  test("routes a first timeout against a timed-out baseline", () =>
    expect(gateTimeoutRoute({ ...base, current: scoped, baselineTimedOut: true })).toEqual({
      gates: ["scoped"],
      why: "baseline",
    }));
  test("baseline takes precedence over repetition", () =>
    expect(gateTimeoutRoute({ ...base, previous: scoped, current: scoped, baselineTimedOut: true })?.why).toBe(
      "baseline",
    ));
  test("allows a first timeout with a healthy baseline", () =>
    expect(gateTimeoutRoute({ ...base, previous: empty, current: scoped })).toBeNull());
  test("does not confuse different gates", () =>
    expect(gateTimeoutRoute({ ...base, previous: empty, previousSuite: suite, current: scoped })).toBeNull());
  test("repeats a suite timeout", () =>
    expect(gateTimeoutRoute({ ...base, previousSuite: suite, currentSuite: suite })).toEqual({
      gates: ["full-suite"],
      why: "repeated",
    }));
  test("ignores a baseline timeout without a current timeout", () =>
    expect(gateTimeoutRoute({ ...base, current: empty, currentSuite: empty, baselineTimedOut: true })).toBeNull());
  test("returns all current timed out gates without duplicates", () =>
    expect(
      gateTimeoutRoute({ ...base, previous: scoped, current: scoped, currentSuite: gate("scoped", "full-suite") }),
    ).toEqual({ gates: ["scoped", "full-suite"], why: "repeated" }));
});
