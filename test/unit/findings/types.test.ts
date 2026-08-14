import { describe, expect, test } from "bun:test";
import { findingKey, findingRecurrenceKey } from "@/findings";
import type { Finding } from "@/findings";

function finding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return { severity: "error", category: "test", ...overrides };
}

describe("findingKey", () => {
  test("differs when only the message differs", () => {
    const a = finding({ source: "lint", message: "unused var", file: "src/a.ts", line: 1 });
    const b = finding({ source: "lint", message: "different wording", file: "src/a.ts", line: 1 });
    expect(findingKey(a)).not.toBe(findingKey(b));
  });
});

describe("findingRecurrenceKey — nax#1581", () => {
  test("matches when file/line/rule are identical but message differs", () => {
    const a = finding({ source: "semantic-review", message: "cannot return X", file: "src/a.ts", line: 10, rule: "AC-2" });
    const b = finding({ source: "semantic-review", message: "violates AC-2", file: "src/a.ts", line: 10, rule: "AC-2" });
    expect(findingRecurrenceKey(a)).toBe(findingRecurrenceKey(b));
  });

  test("differs when line differs, even with the same message", () => {
    const a = finding({ source: "semantic-review", message: "same", file: "src/a.ts", line: 10, rule: "AC-2" });
    const b = finding({ source: "semantic-review", message: "same", file: "src/a.ts", line: 20, rule: "AC-2" });
    expect(findingRecurrenceKey(a)).not.toBe(findingRecurrenceKey(b));
  });

  test("falls back to findingKey (message included) when file/line/rule are all absent", () => {
    const a = finding({ source: "tdd-verifier", message: "finding-a" });
    const b = finding({ source: "tdd-verifier", message: "finding-b" });
    expect(findingRecurrenceKey(a)).not.toBe(findingRecurrenceKey(b));
    expect(findingRecurrenceKey(a)).toBe(findingKey(a));
  });
});
