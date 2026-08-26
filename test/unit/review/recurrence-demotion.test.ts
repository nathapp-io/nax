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

function adv(sev: string, over: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
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
