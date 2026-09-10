import { describe, expect, test } from "bun:test";
import type { Finding, FindingSeverity, Iteration } from "@/findings";
import {
  classifyRecurrence,
  countPriorAppearances,
  fingerprintFor,
  normalizeIssueText,
  tagCoverageGap,
} from "@/review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";

function iter(
  num: number,
  findings: Array<{ file: string; category: string; message: string; severity: FindingSeverity; acIndex?: number }>,
): Iteration {
  return {
    iterationNum: num,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: findings.map(
      (f): Finding => ({
        source: "adversarial-review",
        severity: f.severity,
        category: f.category,
        file: f.file,
        message: f.message,
        ...(f.acIndex !== undefined ? { meta: { acIndex: f.acIndex } } : {}),
      }),
    ),
    outcome: "unchanged",
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
  };
}

/**
 * Verbatim leading clauses from `auth-security-hardening` US-004, the 17-round
 * adversarial non-convergence recorded in
 * `docs/findings/2026-08-01-review-pipeline-gap-analysis.md` (F1).
 *
 * Every one of these is the SAME defect re-worded. Under the pre-fix prose
 * fingerprint each round produced a distinct key, so `countPriorAppearances`
 * never reached `maxBlockingRounds + 1` and demotion never fired.
 */
const AC3_KEY_FORMAT = [
  "The implementation rejects the key format produced by DefaultMfaService. That service emits tenantId:userId:code",
  "checkAndReserve rejects the three-part replay keys produced by DefaultMfaService, so it returns false without",
  "The implementation rejects the three-part key format emitted by DefaultMfaService (tenantId:userId:code) because",
  "The IAM MFA service constructs replay keys with three colon-separated components, but this adapter requires four",
];
const AC4_TIMESTEP = [
  "The production replay key is tenant:user:code, but this implementation treats the code as codeHash and derives",
  "When callers provide the actual IAM replay-key format (tenant:user:code), timeStep falls back to Date.now()",
  "For the actual IAM key format (tenantId:userId:code), timeStep falls back to the current millisecond clock",
  "The IAM service supplies keys in the form tenantId:userId:code, so timeStepRaw is absent and a new Date is",
  "When callers provide the actual IAM replay key, no time step is present, so timeStep is derived from Date.now()",
  "When the IAM key has the actual format tenantId:userId:code, timeStep falls back to Date.now() in milliseconds",
];
const REPLAY_STORE = "lib/prisma-totp-replay.store.ts";

describe("normalizeIssueText", () => {
  test("strips backticks, collapses whitespace, lowercases, truncates to 160", () => {
    expect(normalizeIssueText("The `foo`   is\nBROKEN")).toBe("the foo is broken");
    expect(normalizeIssueText("x".repeat(200)).length).toBe(160);
  });
});

describe("fingerprintFor", () => {
  test("stable across line-shift and tail rephrase", () => {
    const a = fingerprintFor(
      "lib/store.ts",
      "assumption",
      "window expiry is non-atomic because findFirst runs before upsert",
    );
    const b = fingerprintFor(
      "lib/store.ts",
      "assumption",
      "Window expiry is non-atomic because findFirst runs before upsert — and one more clause",
    );
    expect(a).toBe(b);
  });
  test("distinct across file and category", () => {
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(
      fingerprintFor("b.ts", "input", "same text here padded padded padded"),
    );
    expect(fingerprintFor("a.ts", "input", "same text here padded padded padded")).not.toBe(
      fingerprintFor("a.ts", "assumption", "same text here padded padded padded"),
    );
  });
  test("normalizes backslash paths to forward slashes", () => {
    expect(fingerprintFor("lib\\store.ts", "x", "text")).toBe(fingerprintFor("lib/store.ts", "x", "text"));
  });
  test("normalizes ./ and ../ prefixes so a reviewer's cwd drift does not fragment the key", () => {
    const canonical = fingerprintFor("lib/store.ts", "x", "text");
    expect(fingerprintFor("./lib/store.ts", "x", "text")).toBe(canonical);
    expect(fingerprintFor("../../lib/store.ts", "x", "text")).toBe(canonical);
  });

  // Regression — auth-security-hardening US-004 (F1).
  describe("AC-anchored fingerprint", () => {
    test("is stable across a full prose rewrite when acIndex is present", () => {
      const fps = new Set(AC3_KEY_FORMAT.map((issue) => fingerprintFor(REPLAY_STORE, "input", issue, 3)));
      expect(fps.size).toBe(1);
    });
    test("is stable across a prose rewrite that also changes category", () => {
      // The same AC-4 defect was filed as `assumption` in most rounds and
      // `error-path` in round 12 — category is reviewer-assigned and drifts.
      const a = fingerprintFor(REPLAY_STORE, "assumption", AC4_TIMESTEP[0], 4);
      const b = fingerprintFor(REPLAY_STORE, "error-path", AC4_TIMESTEP[3], 4);
      expect(a).toBe(b);
    });
    test("keeps distinct ACs in the same file distinct — no over-merge", () => {
      const ac3 = fingerprintFor(REPLAY_STORE, "input", AC3_KEY_FORMAT[0], 3);
      const ac4 = fingerprintFor(REPLAY_STORE, "assumption", AC4_TIMESTEP[0], 4);
      expect(ac3).not.toBe(ac4);
    });
    test("keeps the same AC in different files distinct", () => {
      expect(fingerprintFor("a.ts", "input", "text", 3)).not.toBe(fingerprintFor("b.ts", "input", "text", 3));
    });
    test("falls back to the prose fingerprint when acIndex is absent or invalid", () => {
      const prose = fingerprintFor(REPLAY_STORE, "input", AC3_KEY_FORMAT[0]);
      expect(fingerprintFor(REPLAY_STORE, "input", AC3_KEY_FORMAT[0], 0)).toBe(prose);
      expect(fingerprintFor(REPLAY_STORE, "input", AC3_KEY_FORMAT[0], undefined)).toBe(prose);
    });
  });
});

describe("countPriorAppearances", () => {
  test("counts one per iteration containing the fingerprint; tracks most-recent severity", () => {
    const fp = fingerprintFor("lib/store.ts", "assumption", "window expiry non-atomic");
    const priors = [
      iter(1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "error" },
      ]),
      iter(2, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
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
    priors[0].findingsAfter[0].source = "lint";
    expect(countPriorAppearances(priors).size).toBe(0);
  });

  // Regression — auth-security-hardening US-004 (F1).
  test("counts a re-worded finding as recurrent when prior rounds carry meta.acIndex", () => {
    const priors = AC3_KEY_FORMAT.slice(0, 3).map((message, i) =>
      iter(i + 1, [{ file: REPLAY_STORE, category: "input", message, severity: "error", acIndex: 3 }]),
    );
    const fp = fingerprintFor(REPLAY_STORE, "input", AC3_KEY_FORMAT[3], 3);
    expect(countPriorAppearances(priors).get(fp)?.count).toBe(3);
  });
});

const CFG = { enabled: true, maxBlockingRounds: 2 };
const noTest = (_f: string) => false;
const isTest = (_f: string) => true;

type StampedFinding = AdversarialLLMFinding & { meta?: Record<string, unknown> };

type RecurrenceMeta = { disposition: string; rounds: number; wasBlocking?: boolean };

const isRecurrence = (x: unknown): x is RecurrenceMeta =>
  typeof x === "object" && x !== null && "disposition" in x && "rounds" in x;

const recurrenceOf = (f: StampedFinding): RecurrenceMeta => {
  const rec = f.meta?.recurrence;
  if (!isRecurrence(rec)) throw new Error(`expected recurrence meta, got ${JSON.stringify(rec)}`);
  return rec;
};

function adv(sev: string, over: Partial<AdversarialLLMFinding> = {}): StampedFinding {
  return {
    severity: sev,
    category: "assumption",
    file: "lib/store.ts",
    line: 1,
    issue: "window expiry non-atomic",
    suggestion: "fix",
    ...over,
  };
}
function priorAdv(sev: FindingSeverity, n: number): Iteration[] {
  return Array.from({ length: n }, (_v, i) =>
    iter(i + 1, [{ file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: sev }]),
  );
}

describe("classifyRecurrence", () => {
  test("stable error: blocks at n=1 and n=2, demotes at n=3", () => {
    expect(classifyRecurrence([adv("error")], [], CFG, noTest, "error").blocking.length).toBe(1); // n=1
    expect(classifyRecurrence([adv("error")], priorAdv("error", 1), CFG, noTest, "error").blocking.length).toBe(1); // n=2, prev=error
    const r3 = classifyRecurrence([adv("error")], priorAdv("error", 2), CFG, noTest, "error"); // n=3
    expect(r3.blocking.length).toBe(0);
    expect(r3.demoted.length).toBe(1);
  });

  // Regression — auth-security-hardening US-004 (F1). Before the AC-anchored
  // fingerprint this sequence ran 17 rounds without a single demotion, because
  // each round's re-worded prose produced a fresh key.
  test("re-worded blocking finding demotes on round 3 when anchored by acIndex", () => {
    const priors = AC3_KEY_FORMAT.slice(0, 2).map((message, i) =>
      iter(i + 1, [{ file: REPLAY_STORE, category: "input", message, severity: "error", acIndex: 3 }]),
    );
    const round3 = adv("error", { file: REPLAY_STORE, category: "input", issue: AC3_KEY_FORMAT[2], acIndex: 3 });
    const r = classifyRecurrence([round3], priors, CFG, noTest, "error");
    expect(r.demoted.length).toBe(1);
    expect(r.blocking.length).toBe(0);
  });

  // Mixed-key migration: a story mid-flight across a nax upgrade has prose-only
  // priors and AC-anchored current findings. Both directions must still match,
  // or the fix would re-introduce the very loop it removes.
  test("AC-anchored current finding still matches prose-only priors", () => {
    const priors = [1, 2].map((n) =>
      iter(n, [{ file: REPLAY_STORE, category: "input", message: "identical prose", severity: "error" }]),
    );
    const current = adv("error", { file: REPLAY_STORE, category: "input", issue: "identical prose", acIndex: 3 });
    expect(classifyRecurrence([current], priors, CFG, noTest, "error").demoted.length).toBe(1);
  });

  test("prose-only current finding still matches AC-anchored priors", () => {
    const priors = [1, 2].map((n) =>
      iter(n, [{ file: REPLAY_STORE, category: "input", message: "identical prose", severity: "error", acIndex: 3 }]),
    );
    const current = adv("error", { file: REPLAY_STORE, category: "input", issue: "identical prose" });
    expect(classifyRecurrence([current], priors, CFG, noTest, "error").demoted.length).toBe(1);
  });

  test("a different AC in the same file still blocks — demotion does not bleed across ACs", () => {
    const priors = AC3_KEY_FORMAT.slice(0, 2).map((message, i) =>
      iter(i + 1, [{ file: REPLAY_STORE, category: "input", message, severity: "error", acIndex: 3 }]),
    );
    const otherAc = adv("error", {
      file: REPLAY_STORE,
      category: "assumption",
      issue: AC4_TIMESTEP[0],
      acIndex: 4,
    });
    const r = classifyRecurrence([otherAc], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });

  test("oscillating w,e,w,e: never blocks (entry guard)", () => {
    // this round is error, n=2, prev sighting was warning
    const priors = [
      iter(1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
    ];
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
    const priors = Array.from({ length: 2 }, (_v, i) =>
      iter(i + 1, [
        { file: "lib/store.ts", category: "test-gap", message: "window expiry non-atomic", severity: "error" },
      ]),
    );
    const r = classifyRecurrence([f], priors, CFG, noTest, "error");
    expect(r.blocking.length).toBe(0);
    expect(r.demoted.length).toBe(1);
  });

  test("enabled:false → legacy behavior (all error accepted findings block, no demotion)", () => {
    const r = classifyRecurrence(
      [adv("error"), adv("warning")],
      priorAdv("error", 9),
      { enabled: false, maxBlockingRounds: 2 },
      noTest,
      "error",
    );
    expect(r.blocking.length).toBe(1);
    expect(r.advisory.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });
});

describe("tagCoverageGap", () => {
  type TaggedFinding = { file: string; meta?: Record<string, unknown> };

  test("stamps meta.coverageGap: true on every finding", () => {
    const findings: TaggedFinding[] = [{ file: "a.ts", meta: { issue: "x" } }, { file: "b.ts" }];
    const tagged = tagCoverageGap(findings);
    expect(tagged[0]?.meta).toEqual({ issue: "x", coverageGap: true });
    expect(tagged[1]?.meta).toEqual({ coverageGap: true });
  });

  test("leaves untouched findings alone — caller merges tagged + untagged", () => {
    const untouched: TaggedFinding[] = [{ file: "c.ts", meta: { note: "plain advisory" } }];
    expect(untouched[0]?.meta).toEqual({ note: "plain advisory" });
    expect(untouched[0]?.meta?.coverageGap).toBeUndefined();
  });

  test("is immutable — does not mutate the input array or its elements", () => {
    const original: TaggedFinding[] = [{ file: "a.ts", meta: { issue: "x" } }];
    const originalMetaRef = original[0]?.meta;
    const tagged = tagCoverageGap(original);
    expect(original[0]?.meta).toBe(originalMetaRef);
    expect(original[0]?.meta).toEqual({ issue: "x" });
    expect(tagged).not.toBe(original);
    expect(tagged[0]).not.toBe(original[0]);
    expect(tagged[0]?.meta).not.toBe(original[0]?.meta);
  });

  test("empty input returns empty array", () => {
    expect(tagCoverageGap([])).toEqual([]);
  });
});

describe("classifyRecurrence — semantic source (F1b)", () => {
  const semanticIter = (n: number, message: string, acIndex?: number): Iteration => ({
    iterationNum: n,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [
      {
        source: "semantic-review",
        severity: "error",
        category: "",
        file: REPLAY_STORE,
        message,
        ...(acIndex !== undefined ? { meta: { acIndex } } : {}),
      },
    ],
    outcome: "unchanged",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:01.000Z",
  });

  // Semantic findings carry no `category`, so the fingerprint's prose fallback
  // sees category undefined — the AC anchor is what has to carry them.
  const semFinding = (issue: string, acIndex?: number) =>
    ({ severity: "error", file: REPLAY_STORE, issue, acIndex }) as AdversarialLLMFinding;

  test("counts semantic-source priors and demotes on the third sighting", () => {
    const priors = [semanticIter(1, AC3_KEY_FORMAT[0], 3), semanticIter(2, AC3_KEY_FORMAT[1], 3)];
    const r = classifyRecurrence([semFinding(AC3_KEY_FORMAT[2], 3)], priors, CFG, noTest, "error", "semantic-review");
    expect(r.demoted.length).toBe(1);
    expect(r.blocking.length).toBe(0);
  });

  test("ignores adversarial-source priors when counting for semantic", () => {
    const advPriors = [1, 2].map((n) =>
      iter(n, [{ file: REPLAY_STORE, category: "", message: AC3_KEY_FORMAT[0], severity: "error", acIndex: 3 }]),
    );
    const r = classifyRecurrence(
      [semFinding(AC3_KEY_FORMAT[2], 3)],
      advPriors,
      CFG,
      noTest,
      "error",
      "semantic-review",
    );
    expect(r.blocking.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });

  test("disabled config leaves every blocking finding blocking", () => {
    const priors = [semanticIter(1, AC3_KEY_FORMAT[0], 3), semanticIter(2, AC3_KEY_FORMAT[1], 3)];
    const off = { enabled: false, maxBlockingRounds: 2 };
    const r = classifyRecurrence([semFinding(AC3_KEY_FORMAT[2], 3)], priors, off, noTest, "error", "semantic-review");
    expect(r.blocking.length).toBe(1);
    expect(r.demoted.length).toBe(0);
  });
});

// ─── US-001: terminal advisory recurrence (retired bucket + meta stamping) ──

describe("classifyRecurrence — terminal advisory retirement", () => {
  const cfgWithAdvisory = { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 3 };

  // AC 1 — returns all five buckets.
  test("returns blocking, advisory, demoted, retired, and classified arrays", () => {
    const r = classifyRecurrence([adv("error")], [], cfgWithAdvisory, noTest, "error");
    expect(r).toHaveProperty("blocking");
    expect(r).toHaveProperty("advisory");
    expect(r).toHaveProperty("demoted");
    expect(r).toHaveProperty("retired");
    expect(r).toHaveProperty("classified");
    expect(Array.isArray(r.blocking)).toBe(true);
    expect(Array.isArray(r.advisory)).toBe(true);
    expect(Array.isArray(r.demoted)).toBe(true);
    expect(Array.isArray(r.retired)).toBe(true);
    expect(Array.isArray(r.classified)).toBe(true);
  });

  // AC 2 — sub-threshold (warning) below maxAdvisoryRounds → advisory, not retired.
  test("warning below maxAdvisoryRounds → advisory and not retired", () => {
    const priors = [
      iter(1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
    ]; // n=2 (< maxAdvisoryRounds=3)
    const r = classifyRecurrence([adv("warning")], priors, cfgWithAdvisory, noTest, "error");
    expect(r.advisory.length).toBe(1);
    expect(r.retired.length).toBe(0);
    expect(r.classified.length).toBe(1);
  });

  // AC 3 — sub-threshold at-or-above maxAdvisoryRounds → retired.
  test("sub-threshold at maxAdvisoryRounds → retired and not advisory", () => {
    const priors = Array.from({ length: 3 }, (_v, i) =>
      iter(i + 1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
    ); // n=4 (>= maxAdvisoryRounds=3)
    const r = classifyRecurrence([adv("warning")], priors, cfgWithAdvisory, noTest, "error");
    expect(r.retired.length).toBe(1);
    expect(r.advisory.length).toBe(0);
  });

  // AC 4 — blocking at maxBlockingRounds+1 → demoted (not retired).
  test("error at maxBlockingRounds+1 → demoted and not retired", () => {
    const r = classifyRecurrence([adv("error")], priorAdv("error", 2), cfgWithAdvisory, noTest, "error");
    expect(r.demoted.length).toBe(1);
    expect(r.retired.length).toBe(0);
  });

  // AC 5 — default maxAdvisoryRounds is 2 when omitted.
  test("sub-threshold at default maxAdvisoryRounds=2 → retired", () => {
    const cfgNoAdvisory = { enabled: true, maxBlockingRounds: 2 }; // no maxAdvisoryRounds
    const priors = [
      iter(1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
    ]; // n=2 (>= default 2)
    const r = classifyRecurrence([adv("warning")], priors, cfgNoAdvisory, noTest, "error");
    expect(r.retired.length).toBe(1);
    expect(r.advisory.length).toBe(0);
  });
});

describe("classifyRecurrence — meta.recurrence stamping", () => {
  const cfgWithAdvisory = { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 3 };

  // AC 6 — disposition stamped on every classified finding.
  test("every classified finding carries meta.recurrence.disposition matching its bucket", () => {
    const error = adv("error"); // blocking (n=1, no priors)
    const warningFresh = adv("warning", { issue: "fresh advisory" });
    const warningTired = adv("warning", { issue: "tired finding" });
    const priorsForTired = Array.from({ length: 3 }, (_v, i) =>
      iter(i + 1, [{ file: "lib/store.ts", category: "assumption", message: "tired finding", severity: "warning" }]),
    );
    const errorWillDemote = adv("error", { issue: "demote me" });
    const priorsForDemote = priorAdv("error", 2).map((it) => ({
      ...it,
      findingsAfter: it.findingsAfter.map((f) => ({ ...f, message: "demote me" })),
    }));
    const r = classifyRecurrence(
      [error, warningFresh, warningTired, errorWillDemote],
      [
        ...priorsForTired,
        ...priorsForDemote.map((it) => ({
          ...it,
          findingsAfter: it.findingsAfter.map((f) => ({ ...f, message: "demote me" })),
        })),
      ],
      cfgWithAdvisory,
      noTest,
      "error",
    );
    const byIssue = new Map<string, StampedFinding>(r.classified.map((f) => [f.issue, f]));
    expect(byIssue.get("window expiry non-atomic")?.meta?.recurrence).toMatchObject({
      disposition: "blocking",
    });
    expect(byIssue.get("fresh advisory")?.meta?.recurrence).toMatchObject({
      disposition: "advisory",
    });
    expect(byIssue.get("tired finding")?.meta?.recurrence).toMatchObject({
      disposition: "retired",
    });
    expect(byIssue.get("demote me")?.meta?.recurrence).toMatchObject({
      disposition: "demoted",
    });
  });

  // AC 7 — demoted carries wasBlocking=true.
  test("demoted finding carries meta.recurrence.wasBlocking=true", () => {
    const r = classifyRecurrence([adv("error")], priorAdv("error", 2), cfgWithAdvisory, noTest, "error");
    const demoted = r.classified[0];
    expect(demoted.meta?.recurrence).toMatchObject({
      wasBlocking: true,
    });
  });

  // AC 8 — retired carries wasBlocking=false.
  test("retired finding carries meta.recurrence.wasBlocking=false", () => {
    const priors = Array.from({ length: 3 }, (_v, i) =>
      iter(i + 1, [
        { file: "lib/store.ts", category: "assumption", message: "window expiry non-atomic", severity: "warning" },
      ]),
    );
    const r = classifyRecurrence([adv("warning")], priors, cfgWithAdvisory, noTest, "error");
    const retired = r.classified[0];
    expect(retired.meta?.recurrence).toMatchObject({
      wasBlocking: false,
    });
  });

  // AC 9 — rounds = prior count + 1 on every classified finding.
  test("every classified finding carries meta.recurrence.rounds = prior+1", () => {
    const priors = priorAdv("error", 1); // 1 prior → n=2
    const fresh = adv("warning", { issue: "fresh thing" }); // 0 prior → n=1
    const r = classifyRecurrence([adv("error"), fresh], priors, cfgWithAdvisory, noTest, "error");
    expect(recurrenceOf(r.classified[0]).rounds).toBe(2);
    expect(recurrenceOf(r.classified[1]).rounds).toBe(1);
  });

  // AC 10 — classified has one entry per input finding in input order.
  test("classified has one entry per input finding in input order", () => {
    const a = adv("error", { issue: "alpha" });
    const b = adv("warning", { issue: "beta" });
    const c = adv("error", { issue: "gamma" });
    const r = classifyRecurrence([a, b, c], [], cfgWithAdvisory, noTest, "error");
    expect(r.classified.length).toBe(3);
    expect(r.classified[0].issue).toBe("alpha");
    expect(r.classified[1].issue).toBe("beta");
    expect(r.classified[2].issue).toBe("gamma");
  });

  // AC 11 — input findings without meta are not given one.
  test("does not add meta to input findings that have no meta", () => {
    const f: StampedFinding = adv("error", { issue: "no meta here" });
    expect(f.meta).toBeUndefined();
    classifyRecurrence([f], [], cfgWithAdvisory, noTest, "error");
    expect(f.meta).toBeUndefined();
  });

  // AC 12 — unrelated meta keys are preserved alongside meta.recurrence.
  test("preserves unrelated meta keys and adds meta.recurrence", () => {
    const f: StampedFinding = {
      ...adv("error", { issue: "with extra" }),
      meta: { acIndex: 4, note: "preserve me" },
    };
    const r = classifyRecurrence([f], [], cfgWithAdvisory, noTest, "error");
    const stamped = r.classified[0];
    expect(stamped.meta?.note).toBe("preserve me");
    expect(stamped.meta?.acIndex).toBe(4);
    expect(recurrenceOf(stamped).disposition).toBe("blocking");
  });
});

describe("classifyRecurrence — disabled config leaves no recurrence traces", () => {
  // AC 13 — empty retired when disabled.
  test("returns an empty retired array when enabled=false", () => {
    const r = classifyRecurrence(
      [adv("error"), adv("warning")],
      priorAdv("error", 9),
      { enabled: false, maxBlockingRounds: 2 },
      noTest,
      "error",
    );
    expect(r.retired.length).toBe(0);
  });

  // AC 14 — no meta.recurrence stamped when disabled.
  test("no finding carries meta.recurrence when enabled=false", () => {
    const r = classifyRecurrence(
      [adv("error"), adv("warning")],
      priorAdv("error", 9),
      { enabled: false, maxBlockingRounds: 2 },
      noTest,
      "error",
    );
    for (const f of [...r.blocking, ...r.advisory, ...r.demoted, ...r.retired, ...r.classified]) {
      if (f.meta !== undefined) {
        expect(f.meta.recurrence).toBeUndefined();
      }
    }
    expect(r.classified.length).toBe(0);
  });

  // AC 15 — partitions by severity alone when disabled, matching legacy behavior.
  test("partitions by severity alone when enabled=false (legacy behavior)", () => {
    const r = classifyRecurrence(
      [adv("error"), adv("warning"), adv("info")],
      priorAdv("error", 9),
      { enabled: false, maxBlockingRounds: 2 },
      noTest,
      "error",
    );
    expect(r.blocking.length).toBe(1); // error
    expect(r.advisory.length).toBe(2); // warning + info
    expect(r.demoted.length).toBe(0);
    expect(r.retired.length).toBe(0);
  });
});

describe("classifyRecurrence — fingerprint fallback and empty priors", () => {
  // AC 16 — finding without acIndex uses prose fingerprint and disposition is unaffected.
  test("finding without acIndex uses file/category/issue-prefix fingerprint and disposition unaffected", () => {
    const priors = [
      iter(1, [
        {
          file: "lib/store.ts",
          category: "assumption",
          message: "window expiry non-atomic",
          severity: "error",
          acIndex: undefined,
        },
      ]),
      iter(2, [
        {
          file: "lib/store.ts",
          category: "assumption",
          message: "window expiry non-atomic",
          severity: "error",
          acIndex: undefined,
        },
      ]),
    ];
    const current = adv("error"); // no acIndex
    const r = classifyRecurrence([current], priors, CFG, noTest, "error");
    // Prose fingerprint matches the same finding as the AC-anchored tests above:
    // n=3 >= maxBlockingRounds+1 → demoted.
    expect(r.demoted.length).toBe(1);
    expect(r.blocking.length).toBe(0);
  });

  // AC 17 — empty priorIterations → empty retired.
  test("returns empty retired when priorIterations is empty", () => {
    const r = classifyRecurrence([adv("warning"), adv("error")], [], CFG, noTest, "error");
    expect(r.retired.length).toBe(0);
  });

  // AC 18 — empty priorIterations → every classified entry has rounds=1.
  test("every classified entry has meta.recurrence.rounds=1 when priorIterations is empty", () => {
    const r = classifyRecurrence([adv("warning"), adv("error")], [], CFG, noTest, "error");
    for (const f of r.classified) {
      expect(recurrenceOf(f).rounds).toBe(1);
    }
  });
});

describe("tagCoverageGap — preserves recurrence meta", () => {
  // AC 21 — tagCoverageGap preserves meta.recurrence alongside coverageGap:true.
  test("preserves meta.recurrence alongside coverageGap:true", () => {
    type TaggedFinding = { file: string; meta?: Record<string, unknown> };
    const finding: TaggedFinding = {
      file: "lib/store.ts",
      meta: {
        recurrence: { disposition: "retired", rounds: 4, wasBlocking: false },
        otherNote: "untouched",
      },
    };
    const tagged = tagCoverageGap([finding]);
    expect(tagged[0]?.meta?.coverageGap).toBe(true);
    expect(tagged[0]?.meta?.recurrence).toEqual({ disposition: "retired", rounds: 4, wasBlocking: false });
    expect(tagged[0]?.meta?.otherNote).toBe("untouched");
  });
});
