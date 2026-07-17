import { describe, expect, test } from "bun:test";
import {
  fingerprintFor,
  normalizeIssueText,
  countPriorAppearances,
  classifyRecurrence,
} from "@/review/recurrence-demotion";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
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

const CFG = { enabled: true, maxBlockingRounds: 2 };
const noTest = (_f: string) => false;
const isTest = (_f: string) => true;

function adv(sev: string, over: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return { severity: sev, category: "assumption", file: "lib/store.ts", line: 1, issue: "window expiry non-atomic", suggestion: "fix", ...over };
}
function priorAdv(sev: string, n: number): Iteration[] {
  return Array.from({ length: n }, (_v, i) => iter(i + 1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: sev }]));
}

describe("classifyRecurrence", () => {
  test("stable error: blocks at n=1 and n=2, demotes at n=3", () => {
    expect(classifyRecurrence([adv("error")], [], CFG, noTest, "error").blocking.length).toBe(1);       // n=1
    expect(classifyRecurrence([adv("error")], priorAdv("error", 1), CFG, noTest, "error").blocking.length).toBe(1); // n=2, prev=error
    const r3 = classifyRecurrence([adv("error")], priorAdv("error", 2), CFG, noTest, "error");           // n=3
    expect(r3.blocking.length).toBe(0);
    expect(r3.demoted.length).toBe(1);
  });

  test("oscillating w,e,w,e: never blocks (entry guard)", () => {
    // this round is error, n=2, prev sighting was warning
    const priors = [iter(1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" }])];
    const r = classifyRecurrence([adv("error")], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length + r.demoted.length).toBe(1);
  });

  test("non-error accepted finding is advisory, never blocking", () => {
    const r = classifyRecurrence([adv("warning")], [], CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length).toBe(1);
  });

  test("test-gap on a test-file path blocks regardless of recurrence", () => {
    const f = adv("error", { category: "test-gap", file: "test/store.spec.ts" });
    const r = classifyRecurrence([f], priorAdv("error", 5), CFG, isTest, "error");
    expect(r.blocking.length).toBe(1);
  });

  test("non-blocking (warning) test-gap on a test-file path does NOT block", () => {
    const f = adv("warning", { category: "test-gap", file: "test/store.spec.ts" });
    const r = classifyRecurrence([f], [], CFG, isTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.advisory.length).toBe(1);
  });

  test("test-gap on a source path is reclassified → subject to recurrence demotion", () => {
    const f = adv("error", { category: "test-gap", file: "lib/store.ts" });
    // n=3 via priors under the SAME fingerprint (category test-gap)
    const priors = Array.from({ length: 2 }, (_v, i) => iter(i + 1, [{ file: "lib/store.ts", category: "test-gap", message: "window expiry non-atomic", severity: "error" }]));
    const r = classifyRecurrence([f], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.demoted.length).toBe(1);
  });

  test("enabled:false → legacy behavior (all error accepted findings block, no demotion)", () => {
    const r = classifyRecurrence([adv("error"), adv("warning")], priorAdv("error", 9), { enabled: false, maxBlockingRounds: 2 }, noTest, "error");
    expect(r.blocking.length).toBe(1);
    expect(r.advisory.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });
});
