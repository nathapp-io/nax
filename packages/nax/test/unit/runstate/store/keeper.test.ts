import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { classifyRunStatePath, RunStateKeeper } from "@/runstate/store";

const P = "/r/.nax/features/f/prd.json";

describe("RunStateKeeper", () => {
  test("records content per path, lists roots, owns only its feature", () => {
    const k = new RunStateKeeper("run-1", "f");
    const p = classifyRunStatePath(P);
    assertDefined(p, "path");
    k.record(P, p, "{}");
    expect(k.get(P)?.content).toBe("{}");
    expect(k.roots()).toEqual(["/r"]);
    const other = classifyRunStatePath("/r/.nax/features/g/prd.json");
    assertDefined(other, "g");
    expect(k.owns(other)).toBe(false);
  });

  test("in-flight is counted, so overlapping writes keep the mark", () => {
    const k = new RunStateKeeper("run-1", "f");
    k.begin(P);
    k.begin(P);
    k.end(P);
    expect(k.isInFlight(P)).toBe(true);
    k.end(P);
    expect(k.isInFlight(P)).toBe(false);
  });
});
