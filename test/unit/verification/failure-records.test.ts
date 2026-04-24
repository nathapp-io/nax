import { describe, expect, test } from "bun:test";
import { buildFailureRecords } from "../../../src/verification/failure-records";

describe("buildFailureRecords", () => {
  test("maps structured failures without fallback text", () => {
    const result = buildFailureRecords({
      passed: 0,
      failed: 1,
      failures: [
        {
          file: "test/unit/example.test.ts",
          testName: "handles retries",
          error: "Expected true to be false",
          stackTrace: ["at test/unit/example.test.ts:12:3"],
        },
      ],
    });

    expect(result).toEqual([
      {
        file: "test/unit/example.test.ts",
        test: "handles retries",
        message: "Expected true to be false",
        output: "at test/unit/example.test.ts:12:3",
      },
    ]);
  });

  test("falls back to a raw-output failure record when parsing found no structured failures", () => {
    const result = buildFailureRecords(
      {
        passed: 0,
        failed: 2,
        failures: [],
      },
      "src/foo.ts:1:1 - error TS2304: Cannot find name 'missingSymbol'",
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.test).toBe("Unmapped test failures (2 detected)");
    expect(result[0]?.message).toContain("Structured test failure parsing returned no failure records");
    expect(result[0]?.output).toContain("Cannot find name 'missingSymbol'");
  });
});
