import { describe, expect, test } from "bun:test";
import type { Finding, FindingSeverity, Iteration } from "@/findings";
import { classifyRecurrence, stampRecurrenceMeta, tagCoverageGap } from "@/review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";

type StampedFinding = AdversarialLLMFinding & { meta?: Record<string, unknown> };
type RecurrenceMeta = { disposition: string; rounds: number; wasBlocking: boolean };

const noTest = (_file: string) => false;
const isTest = (_file: string) => true;
const config = { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 };

function finding(severity: string, over: Partial<StampedFinding> = {}): StampedFinding {
  return {
    severity,
    category: "assumption",
    file: "lib/store.ts",
    line: 1,
    issue: "recurrent issue",
    suggestion: "fix",
    ...over,
  };
}

function iteration(num: number, severity: FindingSeverity, message = "recurrent issue"): Iteration {
  const reviewFinding: Finding = {
    source: "adversarial-review",
    severity,
    category: "assumption",
    file: "lib/store.ts",
    message,
  };
  return {
    iterationNum: num,
    findingsBefore: [],
    findingsAfter: [reviewFinding],
    fixesApplied: [],
    outcome: "unchanged",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:01.000Z",
  };
}

function recurrenceOf(finding: StampedFinding): RecurrenceMeta {
  const recurrence = finding.meta?.recurrence;
  if (!isRecurrenceMeta(recurrence)) throw new Error("missing recurrence stamp");
  return recurrence;
}

function isRecurrenceMeta(value: unknown): value is RecurrenceMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "disposition" in value &&
    "rounds" in value &&
    "wasBlocking" in value &&
    typeof value.disposition === "string" &&
    typeof value.rounds === "number" &&
    typeof value.wasBlocking === "boolean"
  );
}

function recurrenceAt(findings: StampedFinding[], index: number): RecurrenceMeta {
  const finding = findings[index];
  if (!finding) throw new Error(`missing classified finding at index ${index}`);
  return recurrenceOf(finding);
}

describe("classifyRecurrence retirement", () => {
  test("returns every input unchanged in classified when recurrence is disabled", () => {
    const inputs = [finding("error", { issue: "blocking" }), finding("warning", { issue: "advisory" })];
    const result = classifyRecurrence(
      inputs,
      [iteration(1, "error")],
      { enabled: false, maxBlockingRounds: 2 },
      noTest,
      "error",
    );

    expect(result.classified).toEqual(inputs);
    expect(result.classified.map((entry) => entry.meta?.recurrence)).toEqual([undefined, undefined]);
  });

  test("stamps wasBlocking for blocking, advisory, demoted, and retired findings", () => {
    const blocking = finding("error", { issue: "blocking" });
    const advisory = finding("warning", { issue: "advisory" });
    const demoted = finding("error", { issue: "demoted" });
    const retired = finding("warning", { issue: "retired" });
    const priors = [
      iteration(1, "error", "demoted"),
      iteration(2, "error", "demoted"),
      iteration(1, "warning", "retired"),
    ];
    const result = classifyRecurrence([blocking, advisory, demoted, retired], priors, config, noTest, "error");

    expect(recurrenceAt(result.classified, 0).wasBlocking).toBe(true);
    expect(recurrenceAt(result.classified, 1).wasBlocking).toBe(false);
    expect(recurrenceAt(result.classified, 2).wasBlocking).toBe(true);
    expect(recurrenceAt(result.classified, 3).wasBlocking).toBe(false);
  });

  test("keeps wasBlocking on the blocking test-gap carve-out", () => {
    const result = classifyRecurrence(
      [finding("error", { category: "test-gap", file: "test/store.test.ts" })],
      [iteration(1, "error"), iteration(2, "error"), iteration(3, "error")],
      config,
      isTest,
      "error",
    );

    expect(recurrenceAt(result.classified, 0).wasBlocking).toBe(true);
  });

  test("retires sub-threshold findings at the default advisory cap without mutating input metadata", () => {
    const input = finding("warning", { meta: { note: "preserve" } });
    const result = classifyRecurrence(
      [input],
      [iteration(1, "warning")],
      { enabled: true, maxBlockingRounds: 2 },
      noTest,
      "error",
    );

    expect(result.retired).toHaveLength(1);
    expect(result.advisory).toHaveLength(0);
    expect(recurrenceAt(result.classified, 0).disposition).toBe("retired");
    expect(input.meta).toEqual({ note: "preserve" });
  });

  test("demotes blocking findings after the blocking cap instead of retiring them", () => {
    const result = classifyRecurrence(
      [finding("error")],
      [iteration(1, "error"), iteration(2, "error")],
      config,
      noTest,
      "error",
    );

    expect(result.demoted).toHaveLength(1);
    expect(result.retired).toHaveLength(0);
    expect(recurrenceAt(result.classified, 0).disposition).toBe("demoted");
  });
});

describe("recurrence stamp consumers", () => {
  test("tagCoverageGap preserves a recurrence stamp", () => {
    const tagged = tagCoverageGap<{ meta?: Record<string, unknown> }>([
      { meta: { recurrence: { disposition: "retired", rounds: 2, wasBlocking: false } } },
    ]);
    expect(tagged[0]?.meta).toEqual({
      recurrence: { disposition: "retired", rounds: 2, wasBlocking: false },
      coverageGap: true,
    });
  });

  test("stampRecurrenceMeta forwards a complete recurrence stamp", () => {
    const stamped = stampRecurrenceMeta<{ meta?: Record<string, unknown> }>(
      [{ meta: { acQuote: "literal" } }],
      [{ meta: { recurrence: { disposition: "blocking", rounds: 1, wasBlocking: true } } }],
    );
    expect(stamped[0]?.meta).toEqual({
      acQuote: "literal",
      recurrence: { disposition: "blocking", rounds: 1, wasBlocking: true },
    });
  });
});
