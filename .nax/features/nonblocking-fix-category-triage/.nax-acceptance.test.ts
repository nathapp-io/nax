import { describe, expect, test } from "bun:test";
import type { AdversarialLLMFinding } from "../../../src/review/adversarial-helpers";
import { toAdversarialReviewFindings } from "../../../src/review/adversarial-helpers";
import { categoryToFixTarget } from "../../../src/review/category-fix-target";
import { AdversarialReviewConfigSchema } from "../../../src/config/schemas-review";
import { nonBlockingExtraPhases, runNonBlockingFix } from "../../../src/execution/non-blocking-fix";
import type { NonBlockingFixArgs } from "../../../src/execution/non-blocking-fix";
import { llmFindingsToReviewFindings } from "../../../src/review/finding-projection";
import { BLOCKING_CATEGORIES } from "../../../src/review/ac-structural-counterfactual";
import type { ReviewAuditEntry } from "../../../src/review/review-audit";
import {
  makeAutofixImplementerStrategy,
  makeAutofixTestWriterStrategy,
  makeDeclarationSink,
  makeFullSuiteRectifyStrategy,
} from "../../../src/operations";
import type { Finding } from "../../../src/findings/types";
import { makeNaxConfig, makeStory } from "../../../test/helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAdversarialFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return {
    severity: "high",
    category: "abandonment",
    file: "src/foo.ts",
    line: 1,
    issue: "test issue",
    suggestion: "test suggestion",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "adversarial-review",
    severity: "info",
    category: "advisory",
    message: "test",
    ...overrides,
  };
}

// ─── US-001: categoryToFixTarget ─────────────────────────────────────────────

describe("AC-1 through AC-8: categoryToFixTarget", () => {
  test("AC-1: categoryToFixTarget('abandonment') === 'source'", () => {
    expect(categoryToFixTarget("abandonment")).toBe("source");
  });

  test("AC-2: categoryToFixTarget('input') === 'source'", () => {
    expect(categoryToFixTarget("input")).toBe("source");
  });

  test("AC-3: categoryToFixTarget('error-path') === 'source'", () => {
    expect(categoryToFixTarget("error-path")).toBe("source");
  });

  test("AC-4: categoryToFixTarget('assumption') === 'source'", () => {
    expect(categoryToFixTarget("assumption")).toBe("source");
  });

  test("AC-5: categoryToFixTarget('test-gap') === 'test'", () => {
    expect(categoryToFixTarget("test-gap")).toBe("test");
  });

  test("AC-6: categoryToFixTarget('convention') === 'test'", () => {
    expect(categoryToFixTarget("convention")).toBe("test");
  });

  test("AC-7: categoryToFixTarget('some-unrecognized-category') === 'test'", () => {
    expect(categoryToFixTarget("some-unrecognized-category")).toBe("test");
  });

  test("AC-8: all BLOCKING_CATEGORIES → 'source'; test-gap and convention → 'test'", () => {
    for (const cat of BLOCKING_CATEGORIES) {
      expect(categoryToFixTarget(cat)).toBe("source");
    }
    expect(categoryToFixTarget("test-gap")).toBe("test");
    expect(categoryToFixTarget("convention")).toBe("test");
  });
});

// ─── US-002: toAdversarialReviewFindings fixTarget tagging ───────────────────

describe("AC-9, AC-10: toAdversarialReviewFindings fixTarget", () => {
  test("AC-9: abandonment category → fixTarget === 'source'", () => {
    const findings = toAdversarialReviewFindings([makeAdversarialFinding({ category: "abandonment" })]);
    expect(findings[0]?.fixTarget).toBe("source");
  });

  test("AC-10: test-gap category → fixTarget === 'test'", () => {
    const findings = toAdversarialReviewFindings([makeAdversarialFinding({ category: "test-gap" })]);
    expect(findings[0]?.fixTarget).toBe("test");
  });
});

// ─── US-002: llmFindingsToReviewFindings fixTarget propagation ───────────────

describe("AC-11 through AC-13: llmFindingsToReviewFindings fixTarget", () => {
  test("AC-11: input category with adversarial-review source → fixTarget === 'source'", () => {
    const findings = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "input" })],
      { source: "adversarial-review" },
    );
    expect(findings[0]?.fixTarget).toBe("source");
  });

  test("AC-12: abandonment through toAdversarialReviewFindings and llmFindingsToReviewFindings have the same fixTarget", () => {
    const wireFinding = toAdversarialReviewFindings([makeAdversarialFinding({ category: "abandonment" })])[0];
    const reviewFinding = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "abandonment" })],
      { source: "adversarial-review" },
    )[0];
    expect(wireFinding?.fixTarget).toBeDefined();
    expect(reviewFinding?.fixTarget).toBeDefined();
    expect(wireFinding?.fixTarget).toBe(reviewFinding?.fixTarget);
  });

  test("AC-13: unrecognized category → fixTarget === 'test'", () => {
    const findings = llmFindingsToReviewFindings(
      [makeAdversarialFinding({ category: "some-unrecognized-category" })],
      { source: "adversarial-review" },
    );
    expect(findings[0]?.fixTarget).toBe("test");
  });
});

// ─── US-002: ReviewAuditEntry fixTarget persisted through serialization ──────

describe("AC-14: ReviewAuditEntry fixTarget serialization", () => {
  test("AC-14: abandonment finding fixTarget=source survives JSON round-trip", () => {
    const wireFinding = toAdversarialReviewFindings([makeAdversarialFinding({ category: "abandonment" })])[0]!;
    const auditEntry: ReviewAuditEntry = {
      reviewer: "adversarial",
      sessionName: "test-session",
      workdir: "/tmp/test",
      parsed: true,
      result: {
        passed: true,
        findings: [wireFinding],
      },
    };
    const serialized = JSON.stringify(auditEntry);
    const deserialized = JSON.parse(serialized) as typeof auditEntry;
    const deserializedFinding = deserialized.result?.findings?.[0] as typeof wireFinding;
    expect(deserializedFinding?.fixTarget).toBe("source");
  });
});

// ─── US-003: AdversarialReviewConfigSchema with triage scope ─────────────────

describe("AC-15 through AC-17: AdversarialReviewConfigSchema triage scope", () => {
  test("AC-15: scope 'triage' parses successfully", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: { enabled: true, scope: "triage" },
    });
    expect(parsed.nonBlockingFix?.scope).toBe("triage");
  });

  test("AC-16: missing scope defaults to 'both'", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: { enabled: true },
    });
    expect(parsed.nonBlockingFix?.scope).toBe("both");
  });

  test("AC-17: invalid scope throws ZodError", () => {
    expect(() =>
      AdversarialReviewConfigSchema.parse({
        nonBlockingFix: { enabled: true, scope: "invalid" },
      }),
    ).toThrow();
  });
});

// ─── US-003: nonBlockingExtraPhases with triage scope ────────────────────────

describe("AC-18, AC-19: nonBlockingExtraPhases triage scope", () => {
  test("AC-18: triage scope + verifierGuard:true → ['verifier']", () => {
    const phases = nonBlockingExtraPhases({
      scope: "triage" as "source" | "both" | "triage",
      verifierGuard: true,
      enabled: true,
      regressionAttempts: 1,
    });
    expect(Array.from(phases)).toEqual(["verifier"]);
  });

  test("AC-19: triage scope + verifierGuard:false → []", () => {
    const phases = nonBlockingExtraPhases({
      scope: "triage" as "source" | "both" | "triage",
      verifierGuard: false,
      enabled: true,
      regressionAttempts: 1,
    });
    expect(Array.from(phases)).toEqual([]);
  });
});

// ─── US-004: Triage strategy set construction ─────────────────────────────────
//
// The triage branch of buildPlanForStrategy builds a non-blocking strategy set
// where each adversarial finding is routed by fixTarget:
//   - autofix-implementer: claims adversarial findings with fixTarget="source"
//   - autofix-test-writer: claims adversarial findings with fixTarget="test"
//   - full-suite-rectify:  handles test-runner regression failures
//
// We verify this by constructing the strategies as the triage branch would
// and asserting appliesTo behavior.

describe("AC-20 through AC-25: triage strategy set routing", () => {
  const story = makeStory();
  const config = makeNaxConfig();

  function makeTriageStrategySet() {
    const nbSink = makeDeclarationSink();
    // Triage implementer: claims adversarial findings where fixTarget is "source".
    // Uses a new option added by this feature (adversarialReviewByFixTarget: "source").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const autofixImplementer = makeAutofixImplementerStrategy(story, config, nbSink, {
      adversarialReviewByFixTarget: "source",
    } as any);
    // Triage test-writer: disables the blanket adversarial clause so only
    // fixTarget="test" adversarial findings are claimed.
    // Uses a new option added by this feature (includeAdversarialReview: false).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const autofixTestWriter = (makeAutofixTestWriterStrategy as any)(story, config, nbSink, {
      includeAdversarialReview: false,
    });
    const fullSuiteRectify = makeFullSuiteRectifyStrategy(story, config, nbSink);
    return { strategies: [autofixImplementer, autofixTestWriter, fullSuiteRectify], autofixImplementer, autofixTestWriter, fullSuiteRectify };
  }

  function makeBlockingThreeSessionStrategySet() {
    const sink = makeDeclarationSink();
    // Blocking three-session: implementer does NOT claim adversarial; test-writer has blanket clause
    const autofixImplementer = makeAutofixImplementerStrategy(story, config, sink, {
      includeAdversarialReview: false,
    });
    const autofixTestWriter = makeAutofixTestWriterStrategy(story, config, sink);
    const fullSuiteRectify = makeFullSuiteRectifyStrategy(story, config, sink);
    return { strategies: [autofixImplementer, autofixTestWriter, fullSuiteRectify], autofixImplementer, autofixTestWriter, fullSuiteRectify };
  }

  test("AC-20: triage strategy set contains exactly 3 strategies: autofix-implementer, autofix-test-writer, full-suite-rectify", () => {
    const { strategies } = makeTriageStrategySet();
    expect(strategies).toHaveLength(3);
    expect(strategies.map((s) => s.name)).toEqual([
      "autofix-implementer",
      "autofix-test-writer",
      "full-suite-rectify",
    ]);
  });

  test("AC-21: triage — adversarial+source: implementer=true, test-writer=false", () => {
    const { autofixImplementer, autofixTestWriter } = makeTriageStrategySet();
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "source", category: "advisory" });
    expect(autofixImplementer.appliesTo(finding)).toBe(true);
    expect(autofixTestWriter.appliesTo(finding)).toBe(false);
  });

  test("AC-22: triage — adversarial+test: test-writer=true, implementer=false", () => {
    const { autofixImplementer, autofixTestWriter } = makeTriageStrategySet();
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "test", category: "advisory" });
    expect(autofixTestWriter.appliesTo(finding)).toBe(true);
    expect(autofixImplementer.appliesTo(finding)).toBe(false);
  });

  test("AC-23: triage — non-adversarial source (convention/semantic-review) with fixTarget=test: test-writer=true", () => {
    const { autofixTestWriter } = makeTriageStrategySet();
    // AC specifies source='convention' category findings with fixTarget='test'.
    // 'convention' maps to fixTarget='test' via categoryToFixTarget. We test using
    // a non-adversarial-review source to confirm the test-writer claims by fixTarget alone.
    const finding = makeFinding({ source: "semantic-review", fixTarget: "test", category: "convention", severity: "info" });
    expect(autofixTestWriter.appliesTo(finding)).toBe(true);
  });

  test("AC-24: default makeAutofixTestWriterStrategy — adversarial+source: appliesTo=true (blanket adversarial clause preserved)", () => {
    const sink = makeDeclarationSink();
    const strategy = makeAutofixTestWriterStrategy(story, config, sink);
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "source", category: "advisory" });
    expect(strategy.appliesTo(finding)).toBe(true);
  });

  test("AC-25: blocking three-session — adversarial+source: test-writer=true, implementer=false", () => {
    const { autofixImplementer, autofixTestWriter } = makeBlockingThreeSessionStrategySet();
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "source", category: "advisory" });
    expect(autofixTestWriter.appliesTo(finding)).toBe(true);
    expect(autofixImplementer.appliesTo(finding)).toBe(false);
  });
});

// ─── US-005: sourceDiffCap schema defaults ────────────────────────────────────

describe("AC-26: sourceDiffCap schema defaults", () => {
  test("AC-26: unset sourceDiffCap defaults to maxFiles=10, maxLines=500", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: {},
    });
    expect(parsed.nonBlockingFix?.sourceDiffCap?.maxFiles).toBe(10);
    expect(parsed.nonBlockingFix?.sourceDiffCap?.maxLines).toBe(500);
  });
});

// ─── US-005: runNonBlockingFix with sourceDiffCap enforcement ────────────────

describe("AC-27 through AC-30: runNonBlockingFix sourceDiffCap", () => {
  // Use `as any` for cfg.scope and cfg.sourceDiffCap since these are added by the feature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseArgs: any = {
    workdir: "/tmp/test",
    storyId: "us-triage-001",
    advisoryFindings: [makeFinding()],
    cfg: {
      enabled: true,
      scope: "triage",
      regressionAttempts: 0,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    },
  };

  // measureSourceDiff is a new dep added by this feature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeDeps(measureSourceDiff: () => Promise<{ fileCount: number; sourceLineCount: number }>, rollbackCalls: string[]) {
    return {
      captureSnapshotRef: async (_workdir: string, _storyId: string) => "snap-sha",
      rollbackToRef: async (_workdir: string, ref: string) => {
        rollbackCalls.push(ref);
      },
      measureSourceDiff,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  test("AC-27: source diff exceeds maxLines (501) → restored=true even when runRectify succeeds", async () => {
    const rollbackCalls: string[] = [];
    const deps = makeDeps(
      async () => ({ fileCount: 1, sourceLineCount: 501 }),
      rollbackCalls,
    );
    const result = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs: {}, runRectify: async () => ({ rectificationExhausted: false }) },
      deps,
    );
    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(rollbackCalls.length).toBe(1);
  });

  test("AC-28: source diff within maxLines (100) + runRectify succeeds → kept=true", async () => {
    const rollbackCalls: string[] = [];
    const deps = makeDeps(
      async () => ({ fileCount: 1, sourceLineCount: 100 }),
      rollbackCalls,
    );
    const result = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs: {}, runRectify: async () => ({ rectificationExhausted: false }) },
      deps,
    );
    expect(result).toEqual({ ran: true, kept: true, restored: false });
  });

  test("AC-29: measureSourceDiff throws → restored=true and rollback invoked", async () => {
    const rollbackCalls: string[] = [];
    const deps = makeDeps(
      async () => { throw new Error("diff measurement failed"); },
      rollbackCalls,
    );
    const result = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs: {}, runRectify: async () => ({ rectificationExhausted: false }) },
      deps,
    );
    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(rollbackCalls.length).toBe(1);
  });

  test("AC-30: all test files (sourceLineCount=0) within cap → kept=true", async () => {
    const rollbackCalls: string[] = [];
    const deps = makeDeps(
      async () => ({ fileCount: 2, sourceLineCount: 0 }),
      rollbackCalls,
    );
    const result = await runNonBlockingFix(
      { ...baseArgs, phaseOutputs: {}, runRectify: async () => ({ rectificationExhausted: false }) },
      deps,
    );
    expect(result).toEqual({ ran: true, kept: true, restored: false });
  });
});