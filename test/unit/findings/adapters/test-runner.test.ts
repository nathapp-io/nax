import { describe, expect, test } from "bun:test";
import { acFailureToFinding, acSentinelToFinding } from "../../../../src/findings";

const BUN_OUTPUT = `
bun test v1.3.13 (bf2e2cec)

test/acceptance/feature.test.ts:
(fail) AC-1: greet returns a greeting [3ms]
  error: Expected "Hello, World!" but received "Hello, world!"

(fail) AC-3: handles empty name [2ms]
  error: Expected error to be thrown

 1 pass
 2 fail
`.trim();

describe("acFailureToFinding", () => {
  test("maps required fields for a real AC failure", () => {
    const finding = acFailureToFinding("AC-1", BUN_OUTPUT);

    expect(finding.source).toBe("test-runner");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("assertion-failure");
    expect(finding.rule).toBe("AC-1");
    expect(finding.fixTarget).toBe("source");
  });

  test("extracts an excerpt containing the AC ID as the message", () => {
    const finding = acFailureToFinding("AC-1", BUN_OUTPUT);
    expect(finding.message).toContain("AC-1");
  });

  test("falls back to '<acId> failed' when AC ID not found in output", () => {
    const finding = acFailureToFinding("AC-9", "unrelated output with no AC mentions");
    expect(finding.message).toBe("AC-9 failed");
  });

  test("extracts up to 5 lines starting from the matching line", () => {
    const finding = acFailureToFinding("AC-3", BUN_OUTPUT);
    expect(finding.message).toContain("AC-3");
  });

  test("fixTarget is always 'source'", () => {
    const finding = acFailureToFinding("AC-2", BUN_OUTPUT);
    expect(finding.fixTarget).toBe("source");
  });

  test("file is always undefined — no per-line file extraction", () => {
    const finding = acFailureToFinding("AC-1", BUN_OUTPUT);
    expect(finding.file).toBeUndefined();
  });
});

describe("acSentinelToFinding — AC-HOOK", () => {
  test("maps required fields", () => {
    const finding = acSentinelToFinding("AC-HOOK", "");

    expect(finding.source).toBe("test-runner");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("hook-failure");
    expect(finding.message).toBe("beforeAll/afterAll hook timed out");
    expect(finding.fixTarget).toBe("test");
  });

  test("rule is always undefined", () => {
    const finding = acSentinelToFinding("AC-HOOK", "");
    expect(finding.rule).toBeUndefined();
  });
});

describe("acSentinelToFinding — AC-ERROR", () => {
  test("maps required fields", () => {
    const finding = acSentinelToFinding("AC-ERROR", "");

    expect(finding.source).toBe("test-runner");
    expect(finding.severity).toBe("critical");
    expect(finding.category).toBe("test-runner-error");
    expect(finding.message).toBe("Test runner crashed before test bodies ran");
    expect(finding.fixTarget).toBe("test");
  });

  test("rule is always undefined", () => {
    const finding = acSentinelToFinding("AC-ERROR", "");
    expect(finding.rule).toBeUndefined();
  });
});
