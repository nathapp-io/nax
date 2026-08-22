import { describe, expect, test } from "bun:test";
import { readFinishConfig } from "@/finish";

describe("readFinishConfig", () => {
  test("an absent finish block is disabled with schema defaults", () => {
    const s = readFinishConfig({});
    expect(s.enabled).toBe(false);
    expect(s.narrative).toBe(true);
    expect(s.timeouts).toEqual({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null });
    expect(s.prBody).toEqual({ template: "merge", sectionMap: {} });
    expect(s.models).toEqual({});
  });

  test("reviewer selections become the FinishOpsDeps.models shape", () => {
    const s = readFinishConfig({
      finish: {
        enabled: true,
        reviewers: { spec: "powerful", quality: { agent: "claude", model: "opus" }, narrative: null, fix: "fast" },
      },
    });
    expect(s.models).toEqual({
      reviewSpec: "powerful",
      reviewQuality: { agent: "claude", model: "opus" },
      fix: "fast",
    });
  });

  test("a null reviewer is omitted, not passed as null", () => {
    const s = readFinishConfig({ finish: { enabled: true, reviewers: { spec: null, quality: null, narrative: null, fix: null } } });
    expect("reviewSpec" in s.models).toBe(false);
  });

  test("narrative: false disables the narrative op", () => {
    expect(readFinishConfig({ finish: { enabled: true, narrative: false } }).narrative).toBe(false);
  });

  test("an absent finish block defaults rerun to 'on-change'", () => {
    expect(readFinishConfig({}).rerun).toBe("on-change");
  });

  test("rerun: 'always' is read through", () => {
    expect(readFinishConfig({ finish: { enabled: true, rerun: "always" } }).rerun).toBe("always");
  });
});
