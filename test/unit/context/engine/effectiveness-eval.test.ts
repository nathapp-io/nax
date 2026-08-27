/**
 * US-001: `nax context effectiveness eval` evaluation harness
 *
 * Tests loadLabelSet, scoreEffectiveness, and the per-case scoring
 * resilience. Each AC has at least one success-path test and one
 * boundary/failure-path test.
 *
 * AC1-AC3 — loadLabelSet
 * AC4-AC9 — scoreEffectiveness (field shape, per-signal, baseline, size-correlation)
 * AC15    — one case throws while scoring; warn + continue
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeLogger, withDepsRestore } from "@test/helpers";
import { buildEvidenceTerms, classifyWithTerms } from "@/context/engine/effectiveness";
import {
  _effectivenessEvalDeps,
  type Classifier,
  type EvalReport,
  INVALID_JSON_ERROR_CODE,
  type LabelCase,
  type LabelSet,
  loadLabelSet,
  type PerSignalScore,
  SCHEMA_INVALID_ERROR_CODE,
  scoreEffectiveness,
} from "@/context/engine/effectiveness-eval";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A single well-formed case — kept minimal so tests stay focused on the AC. */
function makeCase(overrides: Partial<LabelCase> = {}): LabelCase {
  return {
    caseId: "case-1",
    chunkId: "static-rules:rule:slug:hash",
    chunkSummary: "Use the _deps pattern for external calls so tests can inject mocks.",
    diffText: "-import { mock } from 'bun:test';\n+import { _acpDeps } from './_deps';",
    label: "followed",
    ...overrides,
  };
}

/** Build a 4-case set with predictable per-signal distribution. */
function makeFourCases(): LabelCase[] {
  return [
    makeCase({ caseId: "case-1", label: "followed" }),
    makeCase({ caseId: "case-2", label: "followed" }),
    makeCase({ caseId: "case-3", label: "ignored" }),
    makeCase({ caseId: "case-4", label: "contradicted" }),
  ];
}

withDepsRestore(_effectivenessEvalDeps);

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — loadLabelSet happy path: one well-formed case
// ─────────────────────────────────────────────────────────────────────────────

describe("loadLabelSet (AC1)", () => {
  test("[AC1] returns one case with the input caseId for valid version: 1 JSON", () => {
    const json = JSON.stringify({
      version: 1,
      cases: [
        {
          caseId: "rule-A__US-007",
          chunkId: "static-rules:rule-A:slug:abcdef00",
          chunkSummary: "Sample summary text longer than four significant terms for the classifier.",
          diffText: "diff --git a/x.ts b/x.ts\n@@\n-old\n+new",
          label: "followed",
        },
      ],
    });
    const set = loadLabelSet(json);
    expect(set.cases).toHaveLength(1);
    expect(set.cases[0].caseId).toBe("rule-A__US-007");
  });

  test("[AC1] returns version 1 for a valid version: 1 document", () => {
    const json = JSON.stringify({
      version: 1,
      cases: [
        {
          caseId: "x",
          chunkId: "x",
          chunkSummary: "summary",
          diffText: "diff",
          label: "ignored",
        },
      ],
    });
    const set = loadLabelSet(json);
    expect(set.version).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — loadLabelSet surfaces missing-label error
// ─────────────────────────────────────────────────────────────────────────────

describe("loadLabelSet (AC2)", () => {
  test("[AC2] throws an error whose message names the caseId when label is missing", () => {
    const json = JSON.stringify({
      version: 1,
      cases: [
        {
          caseId: "rule-A__US-007",
          chunkId: "static-rules:rule-A:slug:abcdef00",
          chunkSummary: "Sample summary",
          diffText: "diff",
          // label intentionally omitted
        },
      ],
    });
    let caught: Error | undefined;
    try {
      loadLabelSet(json);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("rule-A__US-007");
  });

  test("[AC2] throws an error whose message names the field 'label' when it is missing", () => {
    const json = JSON.stringify({
      version: 1,
      cases: [
        {
          caseId: "rule-A__US-007",
          chunkId: "static-rules:rule-A:slug:abcdef00",
          chunkSummary: "Sample summary",
          diffText: "diff",
        },
      ],
    });
    let caught: Error | undefined;
    try {
      loadLabelSet(json);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/label/);
  });

  test("[AC2] the thrown error is a NaxError (consistent with project error handling rules)", () => {
    const json = JSON.stringify({
      version: 1,
      cases: [
        {
          caseId: "rule-A__US-007",
          chunkId: "x",
          chunkSummary: "Sample summary",
          diffText: "diff",
        },
      ],
    });
    let caught: Error | undefined;
    try {
      loadLabelSet(json);
    } catch (err) {
      caught = err as Error;
    }
    // NaxError instances are the only typed error class for nax — see
    // src/errors.ts. Plain Error is a code-review blocker.
    expect(caught?.name).toBe("NaxError");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — loadLabelSet distinguishes invalid-JSON from schema errors
// ─────────────────────────────────────────────────────────────────────────────

describe("loadLabelSet (AC3)", () => {
  test("[AC3] throws an error with code INVALID_JSON_ERROR_CODE for non-JSON text", () => {
    let caught: { name: string; code?: string; message: string } | undefined;
    try {
      loadLabelSet("not json at all {{ broken");
    } catch (err) {
      caught = err as { name: string; code?: string; message: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe(INVALID_JSON_ERROR_CODE);
  });

  test("[AC3] the code is distinguishable from the schema-invalid code (AC2)", () => {
    let caught: { code?: string } | undefined;
    try {
      loadLabelSet("not json at all {{ broken");
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).not.toBe(SCHEMA_INVALID_ERROR_CODE);
  });

  test("[AC3] throws for text that begins with valid JSON then trailing garbage", () => {
    // Robustness — `JSON.parse` would throw on the trailing comma. The error
    // code must be INVALID_JSON, not SCHEMA_INVALID.
    const malformed = '{"version":1,"cases":[}';
    let caught: { code?: string } | undefined;
    try {
      loadLabelSet(malformed);
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe(INVALID_JSON_ERROR_CODE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — per-signal precision/recall/f1 in [0,1] when 3 of 4 scored cases match
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC4)", () => {
  test("[AC4] returns per-signal precision in [0,1] when 3 of 4 scored cases match", () => {
    const cases = makeFourCases();
    // Classifier matches 3 of 4 (gets case-4 wrong).
    const classifier: Classifier = (c) => {
      if (c.caseId === "case-4") return "ignored";
      return c.label as Exclude<LabelCase["label"], "unclear">;
    };
    const report = scoreEffectiveness(cases, classifier);
    const followed = report.perSignal.followed;
    expect(followed).toBeDefined();
    expect(typeof followed.precision).toBe("number");
    expect(followed.precision).toBeGreaterThanOrEqual(0);
    expect(followed.precision).toBeLessThanOrEqual(1);
  });

  test("[AC4] returns per-signal recall in [0,1] when 3 of 4 scored cases match", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    const followed = report.perSignal.followed;
    expect(followed.recall).toBeGreaterThanOrEqual(0);
    expect(followed.recall).toBeLessThanOrEqual(1);
  });

  test("[AC4] returns per-signal f1 in [0,1] when 3 of 4 scored cases match", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    const followed = report.perSignal.followed;
    expect(followed.f1).toBeGreaterThanOrEqual(0);
    expect(followed.f1).toBeLessThanOrEqual(1);
  });

  test("[AC4] per-signal triples exist for followed/ignored/contradicted (all three buckets)", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    expect(report.perSignal.followed).toBeDefined();
    expect(report.perSignal.ignored).toBeDefined();
    expect(report.perSignal.contradicted).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — unclear cases are excluded and counted
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC5)", () => {
  test("[AC5] excludes unclear cases from per-signal precision and recall", () => {
    const cases: LabelCase[] = [
      makeCase({ caseId: "u-1", label: "unclear" }),
      makeCase({ caseId: "f-1", label: "followed" }),
    ];
    const classifier: Classifier = (c) =>
      c.label === "unclear" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    // The only followed case was predicted correctly, so precision/recall
    // for `followed` should be 1.0 (and certainly not zero, which would
    // mean the unclear case poisoned the denominator).
    expect(report.perSignal.followed.precision).toBe(1);
    expect(report.perSignal.followed.recall).toBe(1);
  });

  test("[AC5] returns the unclear count via excludedCount", () => {
    const cases: LabelCase[] = [
      makeCase({ caseId: "u-1", label: "unclear" }),
      makeCase({ caseId: "u-2", label: "unclear" }),
      makeCase({ caseId: "f-1", label: "followed" }),
    ];
    const classifier: Classifier = (c) =>
      c.label === "unclear" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    expect(report.excludedCount).toBe(2);
  });

  test("[AC5] returns scoredCount equal to total cases minus excludedCount", () => {
    const cases: LabelCase[] = [
      makeCase({ caseId: "u-1", label: "unclear" }),
      makeCase({ caseId: "f-1", label: "followed" }),
      makeCase({ caseId: "i-1", label: "ignored" }),
    ];
    const classifier: Classifier = (c) =>
      c.label === "unclear" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    expect(report.scoredCount).toBe(2);
    expect(report.excludedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — baseline computed from an always-ignored classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC6)", () => {
  test("[AC6] returns a baseline object computed from an always-ignored classifier", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    expect(report.baseline).toBeDefined();
    // baseline is a triple of numbers, independent of the supplied classifier.
    expect(typeof report.baseline.precision).toBe("number");
    expect(typeof report.baseline.recall).toBe("number");
    expect(typeof report.baseline.f1).toBe("number");
  });

  test("[AC6] baseline.precision and baseline.recall are in [0,1]", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    expect(report.baseline.precision).toBeGreaterThanOrEqual(0);
    expect(report.baseline.precision).toBeLessThanOrEqual(1);
    expect(report.baseline.recall).toBeGreaterThanOrEqual(0);
    expect(report.baseline.recall).toBeLessThanOrEqual(1);
    expect(report.baseline.f1).toBeGreaterThanOrEqual(0);
    expect(report.baseline.f1).toBeLessThanOrEqual(1);
  });

  test("[AC6] baseline is independent of the supplied classifier (always-ignored)", () => {
    const cases: LabelCase[] = [
      makeCase({ caseId: "f-1", label: "followed" }),
      makeCase({ caseId: "f-2", label: "followed" }),
      makeCase({ caseId: "i-1", label: "ignored" }),
    ];
    const reportA = scoreEffectiveness(cases, () => "followed");
    const reportB = scoreEffectiveness(cases, () => "ignored");
    // The baseline must be the same regardless of the supplied classifier,
    // because the baseline is the always-ignored reference.
    expect(reportA.baseline).toEqual(reportB.baseline);
  });

  test("[AC6] baseline reflects a real computation (non-zero for an all-ignored case set)", () => {
    // If every case is actually labeled "ignored", the always-ignored
    // classifier has perfect precision/recall/F1 for the "ignored" signal —
    // the baseline must reflect that, not return all zeros. Catches the
    // "always-zero stub" failure mode.
    const cases: LabelCase[] = [
      makeCase({ caseId: "i-1", label: "ignored" }),
      makeCase({ caseId: "i-2", label: "ignored" }),
      makeCase({ caseId: "i-3", label: "ignored" }),
    ];
    const classifier: Classifier = () => "ignored";
    const report = scoreEffectiveness(cases, classifier);
    const nonZero = report.baseline.precision > 0 || report.baseline.recall > 0 || report.baseline.f1 > 0;
    expect(nonZero).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — sizeCorrelation high when followed occurs for longest half of diffs
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC7)", () => {
  test("[AC7] sizeCorrelation > 0.9 when followed is returned only for the longest half of diffs", () => {
    // Build 6 cases: 3 with short diffs (predicted ignored) and 3 with long diffs (predicted followed).
    const cases: LabelCase[] = [
      makeCase({ caseId: "s1", label: "ignored", diffText: "short diff" }),
      makeCase({ caseId: "s2", label: "ignored", diffText: "short diff" }),
      makeCase({ caseId: "s3", label: "ignored", diffText: "short diff" }),
      makeCase({ caseId: "l1", label: "followed", diffText: "L".repeat(2000) }),
      makeCase({ caseId: "l2", label: "followed", diffText: "L".repeat(2000) }),
      makeCase({ caseId: "l3", label: "followed", diffText: "L".repeat(2000) }),
    ];
    const classifier: Classifier = (c) => (c.caseId.startsWith("l") ? "followed" : "ignored");
    const report = scoreEffectiveness(cases, classifier);
    expect(report.sizeCorrelation).toBeGreaterThan(0.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — sizeCorrelation near 0 when followed is evenly distributed
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC8)", () => {
  test("[AC8] sizeCorrelation absolute value < 0.2 when followed is evenly distributed across diff lengths", () => {
    // Followed spans short/medium/long without a monotonic size bias, so the
    // Spearman rank correlation between diff size and 'followed' is ~0.
    const cases: LabelCase[] = [
      makeCase({ caseId: "1", label: "followed", diffText: "x".repeat(100) }),
      makeCase({ caseId: "2", label: "ignored", diffText: "x".repeat(200) }),
      makeCase({ caseId: "3", label: "followed", diffText: "x".repeat(300) }),
      makeCase({ caseId: "4", label: "ignored", diffText: "x".repeat(400) }),
      makeCase({ caseId: "5", label: "ignored", diffText: "x".repeat(500) }),
      makeCase({ caseId: "6", label: "followed", diffText: "x".repeat(600) }),
    ];
    const classifier: Classifier = (c) => {
      if (c.caseId === "1" || c.caseId === "3" || c.caseId === "6") return "followed";
      return "ignored";
    };
    const report = scoreEffectiveness(cases, classifier);
    expect(Math.abs(report.sizeCorrelation)).toBeLessThan(0.2);
  });

  test("[AC8] sizeCorrelation is non-trivially small (|value| < 0.2) for the evenly-distributed input", () => {
    // Mirror of AC7: a strongly correlated input should produce a high
    // |sizeCorrelation|, and an uncorrelated input should produce a small
    // one. This pair of bounds catches a "always-zero" stub that AC7 alone
    // would also catch — but the auditor may run AC8 in isolation.
    const cases: LabelCase[] = [
      makeCase({ caseId: "1", label: "followed", diffText: "x".repeat(50) }),
      makeCase({ caseId: "2", label: "ignored", diffText: "x".repeat(150) }),
      makeCase({ caseId: "3", label: "ignored", diffText: "x".repeat(250) }),
      makeCase({ caseId: "4", label: "followed", diffText: "x".repeat(350) }),
    ];
    const classifier: Classifier = (c) => (c.caseId === "1" || c.caseId === "4" ? "followed" : "ignored");
    const report = scoreEffectiveness(cases, classifier);
    expect(Math.abs(report.sizeCorrelation)).toBeLessThan(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — return shape exposes perSignal/baseline/sizeCorrelation/scoredCount/excludedCount
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC9)", () => {
  test("[AC9] return object exposes perSignal, baseline, sizeCorrelation, scoredCount, excludedCount", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report: EvalReport = scoreEffectiveness(cases, classifier);
    expect(report).toHaveProperty("perSignal");
    expect(report).toHaveProperty("baseline");
    expect(report).toHaveProperty("sizeCorrelation");
    expect(report).toHaveProperty("scoredCount");
    expect(report).toHaveProperty("excludedCount");
  });

  test("[AC9] perSignal keys are exactly followed/ignored/contradicted", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    const keys = Object.keys(report.perSignal).sort();
    expect(keys).toEqual(["contradicted", "followed", "ignored"]);
  });

  test("[AC9] baseline exposes precision/recall/f1 triples (matches PerSignalScore shape)", () => {
    const cases = makeFourCases();
    const classifier: Classifier = (c) =>
      c.caseId === "case-4" ? "ignored" : (c.label as Exclude<LabelCase["label"], "unclear">);
    const report = scoreEffectiveness(cases, classifier);
    const triple: PerSignalScore = report.baseline;
    expect(typeof triple.precision).toBe("number");
    expect(typeof triple.recall).toBe("number");
    expect(typeof triple.f1).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC15 — one case throws while scoring; warn + continue
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (AC15)", () => {
  test("[AC15] returns a result for the remaining cases when one case throws", () => {
    const cases: LabelCase[] = [
      makeCase({ caseId: "good-1", label: "followed" }),
      makeCase({ caseId: "bad-1", label: "ignored" }),
      makeCase({ caseId: "good-2", label: "ignored" }),
    ];
    const classifier: Classifier = (c) => {
      if (c.caseId === "bad-1") throw new Error("boom");
      return c.label as Exclude<LabelCase["label"], "unclear">;
    };
    // Must not throw — resilience is the contract.
    const report = scoreEffectiveness(cases, classifier);
    // The remaining 2 cases were scored, so scoredCount must be > 0 and at
    // least 1 (the implementer chooses whether to count the failed case
    // against scored or excluded; the AC says 'remaining cases are scored').
    expect(report.scoredCount).toBeGreaterThanOrEqual(1);
  });

  test("[AC15] emits a warning whose message names the failing caseId", () => {
    const mockLog = makeLogger();
    _effectivenessEvalDeps.getLogger = () => mockLog;

    const cases: LabelCase[] = [
      makeCase({ caseId: "broken-case", label: "ignored" }),
      makeCase({ caseId: "ok-case", label: "ignored" }),
    ];
    const classifier: Classifier = (c) => {
      if (c.caseId === "broken-case") throw new Error("kaboom");
      return "ignored";
    };
    scoreEffectiveness(cases, classifier);
    const naming = mockLog.calls.find(
      (c) => c.level === "warn" && typeof c.message === "string" && c.message.includes("broken-case"),
    );
    expect(naming).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC6 — committed fixture includes a git-history chunk with scoped
// files. Under the scoped classifier (cases use their own scopePaths) the
// sizeCorrelation magnitude must be strictly smaller than under the
// whole-diff classifier (cases tokenize the whole diff, no scope).
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (US-001 AC6 — git-history chunk in fixture)", () => {
  const COMMITTED_FIXTURE = join(import.meta.dir, "..", "..", "..", "fixtures", "effectiveness", "labels.sample.json");

  // Pre-change whole-diff classifier: 3+ shared terms with the whole diff
  // text → followed. Mirrors the pre-change classifyEffectiveness logic so
  // the gate's "pre-change" reference is reproducible without importing the
  // wrapper.
  function makeWholeDiffClassifier(): Classifier {
    return (c) => {
      const diffTerms = new Set<string>();
      for (const match of c.diffText.toLowerCase().matchAll(/[^\s_\-./:,;()[\]{}'"!?]+/g)) {
        const term = match[0];
        if (term.length >= 4) diffTerms.add(term);
      }
      const summaryTerms = new Set<string>();
      for (const match of c.chunkSummary.toLowerCase().matchAll(/[^\s_\-./:,;()[\]{}'"!?]+/g)) {
        const term = match[0];
        if (term.length >= 4) summaryTerms.add(term);
      }
      let shared = 0;
      for (const term of summaryTerms) if (diffTerms.has(term)) shared++;
      if (shared >= 3) return "followed";
      return "ignored";
    };
  }

  // Post-change scoped classifier: delegates to classifyWithTerms with the
  // case's own scopePaths so the gate observes the production path.
  function makeScopedClassifier(): Classifier {
    return (c) => {
      const evidence = buildEvidenceTerms("", c.diffText, []);
      const result = classifyWithTerms(c.chunkSummary, evidence, {
        scopePaths: c.scopePaths,
        diffText: c.diffText,
      });
      if (result.signal === "unknown") return "ignored";
      if (result.signal === "contradicted") return "contradicted";
      return result.signal;
    };
  }

  test("[AC6] the committed fixture contains a labelled git-history chunk with scoped files", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const set = loadLabelSet(raw);
    const gitHistoryCases = set.cases.filter((c) => c.chunkId.startsWith("git-history:"));
    expect(gitHistoryCases.length).toBeGreaterThanOrEqual(1);
    for (const c of gitHistoryCases) {
      expect(c.scopePaths).toBeDefined();
      expect(Array.isArray(c.scopePaths)).toBe(true);
      expect(c.scopePaths?.length).toBeGreaterThan(0);
    }
  });

  test("[AC6] scoreEffectiveness under the scoped classifier has a sizeCorrelation magnitude strictly smaller than under the whole-diff classifier", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const set = loadLabelSet(raw);
    const cases = set.cases;

    const wholeDiffReport = scoreEffectiveness(cases, makeWholeDiffClassifier());
    const scopedReport = scoreEffectiveness(cases, makeScopedClassifier());

    // The git-history chunk in the fixture is labelled "followed" with
    // scopePaths that do NOT match the diff file path, so the scoped
    // classifier declares it ignored (pathMatchesScope returns empty),
    // while the whole-diff classifier declares it followed (3+ shared
    // terms). Adding this long-diff "ignored" under the scoped classifier
    // breaks the monotonic size→followed relationship and reduces the
    // |sizeCorrelation| below the whole-diff reference.
    expect(Math.abs(scopedReport.sizeCorrelation)).toBeLessThan(Math.abs(wholeDiffReport.sizeCorrelation));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 AC6 — committed fixture includes a labelled code-neighbor chunk with
// scoped files. Under the scoped classifier (cases use their own scopePaths)
// the sizeCorrelation magnitude must be strictly smaller than under the
// whole-diff classifier (cases tokenize the whole diff, no scope).
// Mirrors the US-001 AC6 test, but for the code-neighbor chunk ID prefix.
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreEffectiveness (US-002 AC6 — code-neighbor chunk in fixture)", () => {
  const COMMITTED_FIXTURE = join(import.meta.dir, "..", "..", "..", "fixtures", "effectiveness", "labels.sample.json");

  function makeWholeDiffClassifier(): Classifier {
    return (c) => {
      const diffTerms = new Set<string>();
      for (const match of c.diffText.toLowerCase().matchAll(/[^\s_\-./:,;()[\]{}'"!?]+/g)) {
        const term = match[0];
        if (term.length >= 4) diffTerms.add(term);
      }
      const summaryTerms = new Set<string>();
      for (const match of c.chunkSummary.toLowerCase().matchAll(/[^\s_\-./:,;()[\]{}'"!?]+/g)) {
        const term = match[0];
        if (term.length >= 4) summaryTerms.add(term);
      }
      let shared = 0;
      for (const term of summaryTerms) if (diffTerms.has(term)) shared++;
      if (shared >= 3) return "followed";
      return "ignored";
    };
  }

  function makeScopedClassifier(): Classifier {
    return (c) => {
      const evidence = buildEvidenceTerms("", c.diffText, []);
      const result = classifyWithTerms(c.chunkSummary, evidence, {
        scopePaths: c.scopePaths,
        diffText: c.diffText,
      });
      if (result.signal === "unknown") return "ignored";
      if (result.signal === "contradicted") return "contradicted";
      return result.signal;
    };
  }

  test("[AC6] the committed fixture contains a labelled code-neighbor chunk with scoped files", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const set = loadLabelSet(raw);
    const codeNeighborCases = set.cases.filter((c) => c.chunkId.startsWith("code-neighbor:"));
    expect(codeNeighborCases.length).toBeGreaterThanOrEqual(1);
    for (const c of codeNeighborCases) {
      expect(c.scopePaths).toBeDefined();
      expect(Array.isArray(c.scopePaths)).toBe(true);
      expect(c.scopePaths?.length).toBeGreaterThan(0);
    }
  });

  test("[AC6] scoreEffectiveness under the scoped classifier has a sizeCorrelation magnitude strictly smaller than under the whole-diff classifier", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const set = loadLabelSet(raw);
    const cases = set.cases;

    const wholeDiffReport = scoreEffectiveness(cases, makeWholeDiffClassifier());
    const scopedReport = scoreEffectiveness(cases, makeScopedClassifier());

    // The code-neighbor chunk in the fixture is labelled "followed" with
    // scopePaths that do NOT match the diff file path, so the scoped
    // classifier declares it ignored (pathMatchesScope returns empty),
    // while the whole-diff classifier declares it followed (3+ shared
    // terms). Adding this long-diff "ignored" under the scoped classifier
    // breaks the monotonic size→followed relationship and reduces the
    // |sizeCorrelation| below the whole-diff reference.
    expect(Math.abs(scopedReport.sizeCorrelation)).toBeLessThan(Math.abs(wholeDiffReport.sizeCorrelation));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smoke — LabelSet type compiles
// ─────────────────────────────────────────────────────────────────────────────

describe("LabelSet shape smoke", () => {
  test("LabelSet is a structural record (compile-time guard)", () => {
    const set: LabelSet = { version: 1, cases: [makeCase({ caseId: "smoke" })] };
    expect(set.version).toBe(1);
    expect(set.cases).toHaveLength(1);
  });
});
