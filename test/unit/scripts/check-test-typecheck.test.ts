import { describe, expect, test } from "bun:test";
import { formatReport, parseTypecheckOutput } from "../../../scripts/check-test-typecheck";

describe("parseTypecheckOutput", () => {
  test("returns 0 for empty stdout", () => {
    expect(parseTypecheckOutput("")).toEqual({ count: 0, byFile: {} });
  });

  test("counts one error per `error TS<n>:` line", () => {
    const stdout =
      "test/unit/a.test.ts(3,5): error TS2322: not assignable.\n" +
      "test/unit/a.test.ts(8,11): error TS7006: implicit any.\n" +
      "test/unit/b.test.ts(2,1): error TS2741: missing property.\n";
    const { count, byFile } = parseTypecheckOutput(stdout);
    expect(count).toBe(3);
    expect(byFile["test/unit/a.test.ts"]).toBe(2);
    expect(byFile["test/unit/b.test.ts"]).toBe(1);
  });

  test("ignores lines without `error TS` marker", () => {
    const stdout =
      "test/unit/a.test.ts(3,5): error TS2322: x\n" +
      "Some other diagnostic line\n" +
      "Found 1 error in test/unit/a.test.ts\n";
    expect(parseTypecheckOutput(stdout).count).toBe(1);
  });
});

describe("formatReport", () => {
  const v = { count: 1, byFile: { "test/a.test.ts": 1 } };

  test("returns OK when count equals baseline", () => {
    const { ok, message } = formatReport(v, { count: 1, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("baseline 1");
  });

  test("returns OK with shrunk-amount note when count dropped below baseline", () => {
    const { ok, message } = formatReport({ count: 0, byFile: {} }, { count: 5, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("↓ 5 fixed");
  });

  test("returns FAIL when count exceeds baseline", () => {
    const cur = { count: 3, byFile: { "test/a.test.ts": 3 } };
    const baseline = { count: 1, updatedAt: "", byFile: { "test/a.test.ts": 1 } };
    const { ok, message } = formatReport(cur, baseline);
    expect(ok).toBe(false);
    expect(message).toContain("[FAIL]");
    expect(message).toContain("2 new");
    expect(message).toContain("test/a.test.ts");
  });

  test("returns FAIL with instructions when no baseline file", () => {
    const { ok, message } = formatReport(v, null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });
});
