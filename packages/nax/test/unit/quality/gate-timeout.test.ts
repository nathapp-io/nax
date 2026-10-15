import { describe, expect, test } from "bun:test";
import { DEFAULT_FULL_SUITE_TIMEOUT_SECONDS, resolveFullSuiteTimeoutSeconds } from "@/quality/gate-timeout";

describe("resolveFullSuiteTimeoutSeconds", () => {
  test("prefers execution.regressionGate.timeoutSeconds", () => {
    const config = {
      execution: { regressionGate: { timeoutSeconds: 900 }, rectification: { fullSuiteTimeoutSeconds: 60 } },
    };
    expect(resolveFullSuiteTimeoutSeconds(config)).toBe(900);
  });

  test("falls back to execution.rectification.fullSuiteTimeoutSeconds", () => {
    expect(resolveFullSuiteTimeoutSeconds({ execution: { rectification: { fullSuiteTimeoutSeconds: 240 } } })).toBe(
      240,
    );
  });

  test.each([
    ["no config", undefined],
    ["no execution block", {}],
    ["empty execution block", { execution: {} }],
  ])("returns the default with %s", (_label, config) => {
    expect(resolveFullSuiteTimeoutSeconds(config)).toBe(DEFAULT_FULL_SUITE_TIMEOUT_SECONDS);
  });
});
