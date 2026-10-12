import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import { readFinishConfig } from "@/finish";

describe("readFinishConfig", () => {
  test("an absent finish block is disabled with schema defaults", () => {
    const s = readFinishConfig({});
    expect(s.enabled).toBe(false);
    expect(s.deprecatedNarrative).toBe(false);
    expect(s.notify.mode).toBe("draft");
    expect(s.timeouts).toEqual({
      acceptanceMs: 600_000,
      gateMs: 900_000,
      flowMs: 10_800_000,
      reviewMs: 900_000,
      fixMs: 1_200_000,
    });
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
    const s = readFinishConfig({
      finish: { enabled: true, reviewers: { spec: null, quality: null, narrative: null, fix: null } },
    });
    expect("reviewSpec" in s.models).toBe(false);
  });

  test("narrative: false is flagged deprecated", () => {
    expect(readFinishConfig({ finish: { enabled: true, narrative: false } }).deprecatedNarrative).toBe(true);
  });

  test("a reviewers.narrative model is flagged deprecated and not passed on", () => {
    const s = readFinishConfig({ finish: { enabled: true, reviewers: { narrative: "fast" } } });
    expect(s.deprecatedNarrative).toBe(true);
    expect("narrative" in s.models).toBe(false);
  });

  test("the parsed defaults are not deprecated", () => {
    const s = readFinishConfig({ finish: { enabled: true, narrative: true, reviewers: { narrative: null } } });
    expect(s.deprecatedNarrative).toBe(false);
  });

  test("notify mode escalation reads as draft; draft, always and off read through", () => {
    expect(readFinishConfig({ finish: { notify: { mode: "escalation" } } }).notify.mode).toBe("draft");
    expect(readFinishConfig({ finish: { notify: { mode: "draft" } } }).notify.mode).toBe("draft");
    expect(readFinishConfig({ finish: { notify: { mode: "always" } } }).notify.mode).toBe("always");
    expect(readFinishConfig({ finish: { notify: { mode: "off" } } }).notify.mode).toBe("off");
  });

  test("an absent finish block defaults rerun to 'on-change'", () => {
    expect(readFinishConfig({}).rerun).toBe("on-change");
  });

  test("rerun: 'always' is read through", () => {
    expect(readFinishConfig({ finish: { enabled: true, rerun: "always" } }).rerun).toBe("always");
  });
});

describe("readFinishConfig timeouts (finish A)", () => {
  test("defaults: review 15 min, fix 20 min, flow 3 h, acceptance and gate unchanged", () => {
    expect(readFinishConfig(NaxConfigSchema.parse({})).timeouts).toEqual({
      acceptanceMs: 600_000,
      gateMs: 900_000,
      flowMs: 10_800_000,
      reviewMs: 900_000,
      fixMs: 1_200_000,
    });
  });

  test("explicit values win", () => {
    const s = readFinishConfig(
      NaxConfigSchema.parse({ finish: { timeouts: { reviewMs: 1_000, fixMs: 2_000, flowMs: 3_000 } } }),
    );
    expect([s.timeouts.reviewMs, s.timeouts.fixMs, s.timeouts.flowMs]).toEqual([1_000, 2_000, 3_000]);
  });
});
