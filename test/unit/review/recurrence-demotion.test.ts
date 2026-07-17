import { describe, expect, test } from "bun:test";
import {
  fingerprintFor,
  normalizeIssueText,
  countPriorAppearances,
} from "@/review/recurrence-demotion";
import type { Iteration } from "@/findings";

function iter(num: number, findings: Array<{ file: string; category: string; message: string; severity: string }>): Iteration {
  return {
    iterationNum: num,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: findings.map((f) => ({ source: "adversarial-review", severity: f.severity as any, category: f.category, file: f.file, message: f.message })),
    outcome: "fixes-applied" as any,
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
  };
}

describe("normalizeIssueText", () => {
  test("strips backticks, collapses whitespace, lowercases, truncates to 160", () => {
    expect(normalizeIssueText("The `foo`   is\nBROKEN")).toBe("the foo is broken");
    expect(normalizeIssueText("x".repeat(200)).length).toBe(160);
  });
});

describe("fingerprintFor", () => {
  test("stable across line-shift and tail rephrase", () => {
    const a = fingerprintFor("lib/store.ts", "assumption", "window expiry is non-atomic because findFirst runs before upsert");
    const b = fingerprintFor("lib/store.ts", "assumption", "Window expiry is non-atomic because findFirst runs before upsert — and one more clause");
    expect(a).toBe(b);
  });
  test("distinct across file and category", () => {
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(fingerprintFor("b.ts", "input", "same text here padded padded padded"));
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(fingerprintFor("a.ts", "assumption", "same text here padded padded padded"));
  });
  test("normalizes backslash paths to forward slashes", () => {
    expect(fingerprintFor("lib\\store.ts", "x", "text")).toBe(fingerprintFor("lib/store.ts", "x", "text"));
  });
});

describe("countPriorAppearances", () => {
  test("counts one per iteration containing the fingerprint; tracks most-recent severity", () => {
    const fp = fingerprintFor("lib/store.ts", "assumption", "window expiry non-atomic");
    const priors = [
      iter(1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "error" }]),
      iter(2, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" }]),
    ];
    const m = countPriorAppearances(priors);
    expect(m.get(fp)).toEqual({ count: 2, lastSeverity: "warning" });
  });
  test("is cumulative — survives a one-iteration gap", () => {
    const fp = fingerprintFor("a.ts", "input", "same finding text padded padded");
    const priors = [
      iter(1, [{ file: "a.ts", category: "input", message: "same finding text padded padded", severity: "error" }]),
      iter(2, [{ file: "z.ts", category: "other", message: "unrelated", severity: "error" }]),
      iter(3, [{ file: "a.ts", category: "input", message: "same finding text padded padded", severity: "error" }]),
    ];
    expect(countPriorAppearances(priors).get(fp)?.count).toBe(2);
  });
  test("ignores non-adversarial-review findings", () => {
    const priors = [iter(1, [{ file: "a.ts", category: "input", message: "t", severity: "error" }])];
    priors[0].findingsAfter[0].source = "lint" as any;
    expect(countPriorAppearances(priors).size).toBe(0);
  });
});
