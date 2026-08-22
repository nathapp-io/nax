/**
 * runPhase — PhaseDetails payload construction (US-003 ACs 6–11)
 *
 * Verifies that runPhase builds a typed PhaseDetails object on
 * StoryPhaseCompletedEvent for adversarial-review, implementer,
 * and full-suite-gate ops.
 *
 * Assumptions:
 * - The blocking threshold for adversarial-review defaults to "error" when
 *   not explicitly passed via AdversarialReviewInput.blockingThreshold.
 * - isolationPassed is set only when isThreeSession === true (sessionModel
 *   "three-session"), regardless of whether the implementer output has an
 *   isolation field.
 * - bySeverity counts zero for any FindingSeverity key absent from the
 *   normalized findings (no undefined entries).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution";
import type { FindingSeverity } from "@/findings";
import { pipelineEventBus } from "@/pipeline";
import type { StoryPhaseCompletedEvent } from "@/pipeline/event-bus";
import { makeMockCallContext, makeNaxConfig, makeTestRuntime } from "@test/helpers";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeSlot(opName: string): AnySlot {
  return {
    op: {
      kind: "run" as const,
      name: opName,
      stage: "review" as const,
      session: { role: "reviewer-adversarial" as const, lifetime: "fresh" as const },
      build: () => ({ prompt: "" }),
      parse: () => ({}),
    } as any,
    input: {},
  };
}

async function capturePhaseEvent(fn: () => Promise<unknown>): Promise<StoryPhaseCompletedEvent | undefined> {
  const events: StoryPhaseCompletedEvent[] = [];
  const unsub = pipelineEventBus.on("story:phase:completed", (e) => events.push(e));
  try {
    await fn();
  } finally {
    unsub();
  }
  return events[0];
}

function makeNormalizedFinding(severity: FindingSeverity, index = 0) {
  return {
    source: "adversarial-review",
    category: "test",
    severity,
    ruleId: `rule-${index}`,
    file: "src/foo.ts",
    line: index + 1,
    message: `Finding ${index}`,
  };
}

function makeAdversarialOutput(findings: Array<{ severity: FindingSeverity }>) {
  return {
    passed: findings.length === 0,
    findings: [],
    normalizedFindings: findings.map((f, i) => makeNormalizedFinding(f.severity, i)),
    acDropped: [],
  };
}

// ─── deps save / restore ─────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
});

// ─── adversarial-review details (ACs 6–8) ────────────────────────────────────

describe("adversarial-review PhaseDetails", () => {
  test("AC6: details.kind is review for adversarial-review op", async () => {
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput([])) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("review");
  });

  test("AC6 boundary: reviewer field is adversarial for adversarial-review op", async () => {
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput([])) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.reviewer).toBe("adversarial");
  });

  test("AC7: bySeverity counts match the severities of normalized findings", async () => {
    const findings = [
      { severity: "critical" as FindingSeverity },
      { severity: "error" as FindingSeverity },
      { severity: "error" as FindingSeverity },
      { severity: "warning" as FindingSeverity },
    ];
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput(findings)) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const bySeverity = (event?.details as Record<string, unknown> | undefined)?.bySeverity as
      | Record<string, number>
      | undefined;
    expect(bySeverity?.critical).toBe(1);
    expect(bySeverity?.error).toBe(2);
    expect(bySeverity?.warning).toBe(1);
    // Absent severities must be zero, not undefined
    expect(bySeverity?.info).toBe(0);
    expect(bySeverity?.low).toBe(0);
    expect(bySeverity?.unverifiable).toBe(0);
  });

  test("AC7 boundary: bySeverity is all-zero when no findings", async () => {
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput([])) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const bySeverity = (event?.details as Record<string, unknown> | undefined)?.bySeverity as
      | Record<string, number>
      | undefined;
    expect(bySeverity?.critical).toBe(0);
    expect(bySeverity?.error).toBe(0);
    expect(bySeverity?.warning).toBe(0);
  });

  test("AC8: blockingCount equals findings where isBlockingSeverity is true at error threshold", async () => {
    // critical and error are blocking at the default "error" threshold;
    // warning and info are advisory.
    const findings = [
      { severity: "critical" as FindingSeverity }, // blocking
      { severity: "error" as FindingSeverity }, // blocking
      { severity: "warning" as FindingSeverity }, // advisory
      { severity: "info" as FindingSeverity }, // advisory
    ];
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput(findings)) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.blockingCount).toBe(2);
    expect(details?.advisoryCount).toBe(2);
  });

  test("AC8 boundary: blockingCount is zero when all findings are below blocking threshold", async () => {
    const findings = [
      { severity: "warning" as FindingSeverity },
      { severity: "info" as FindingSeverity },
      { severity: "low" as FindingSeverity },
    ];
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput(findings)) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.blockingCount).toBe(0);
    expect(details?.advisoryCount).toBe(3);
  });

  test("AC16: verbose detail populates details.items with finding messages", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      normalizedFindings: [
        { severity: "error", source: "adversarial-review", message: "missing-null-check" },
        { severity: "warning", source: "adversarial-review", message: "unused-variable" },
      ],
      advisoryFindings: [],
    })) as any;
    const runtime = makeTestRuntime({ config: makeNaxConfig({ reporters: { otel: { detail: "verbose" } } }) });
    const ctx = makeMockCallContext({ runtime, packageView: runtime.packages.repo() });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    const items = details?.items as Array<{ message: string }> | undefined;
    expect(items?.map((i) => i.message)).toContain("missing-null-check");
    expect(items?.map((i) => i.message)).toContain("unused-variable");
  });

  test("AC16: verbose detail's items carry each finding's severity (and rule/file when present)", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      normalizedFindings: [
        {
          severity: "error",
          source: "adversarial-review",
          message: "missing-null-check",
          rule: "no-null",
          file: "src/foo.ts",
        },
      ],
      advisoryFindings: [],
    })) as any;
    const runtime = makeTestRuntime({ config: makeNaxConfig({ reporters: { otel: { detail: "verbose" } } }) });
    const ctx = makeMockCallContext({ runtime, packageView: runtime.packages.repo() });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    const items = details?.items as
      | Array<{ message: string; severity: string; rule?: string; file?: string }>
      | undefined;
    expect(items?.[0]?.severity).toBe("error");
    expect(items?.[0]?.rule).toBe("no-null");
    expect(items?.[0]?.file).toBe("src/foo.ts");
  });

  test("AC16 boundary: counts detail (default) omits items", async () => {
    _storyOrchestratorDeps.callOp = (async () =>
      makeAdversarialOutput([{ severity: "error" as FindingSeverity }])) as any;
    const ctx = makeMockCallContext(); // default detail = "counts"
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-review"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details).not.toHaveProperty("items");
  });
});

// ─── implementer isolation details (ACs 9–10) ────────────────────────────────

describe("implementer PhaseDetails: isolationPassed", () => {
  test("AC9: three-session implementer with isolation.passed=true emits details.isolationPassed=true", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["src/foo.ts"],
      isolation: { passed: true, violations: [] },
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.isolationPassed).toBe(true);
  });

  test("AC9: three-session implementer with isolation.passed=false emits details.isolationPassed=false", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["src/foo.ts"],
      isolation: { passed: false, violations: ["changed file outside src/"] },
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.isolationPassed).toBe(false);
  });

  test("AC10: single-session implementer details omit isolationPassed even when isolation output is present", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["src/foo.ts"],
      isolation: { passed: true, violations: [] },
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      // isThreeSession defaults to false → single-session
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ false),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect("isolationPassed" in (details ?? {})).toBe(false);
  });

  test("AC10 boundary: single-session implementer without isolation output also omits isolationPassed", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: [],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ false),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect("isolationPassed" in (details ?? {})).toBe(false);
  });

  test("AC11: details.filesChanged equals operation output file count", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts"],
      isolation: { passed: true, violations: [] },
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(3);
  });

  test("AC11 boundary: zero files changed emits filesChanged 0", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      filesChanged: [],
      isolation: { passed: true, violations: [] },
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("implementer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(0);
  });
});

// ─── test-writer details (AC12) ──────────────────────────────────────────────

describe("test-writer PhaseDetails", () => {
  test("AC12: emits details.kind='authoring' and details.role='test-writer'", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ filesChanged: ["test/foo.test.ts"] })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("test-writer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("authoring");
    expect(details?.role).toBe("test-writer");
  });

  test("AC12 boundary: filesChanged is counted", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      filesChanged: ["test/a.test.ts", "test/b.test.ts"],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("test-writer"), {}, {}, /* isThreeSession= */ true),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(2);
  });
});

// ─── full-suite-gate details (AC11) ──────────────────────────────────────────

describe("full-suite-gate PhaseDetails", () => {
  test("AC11: full-suite-gate failing emits details with kind gate", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: false,
      passed: false,
      findings: [makeNormalizedFinding("error", 0)],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("full-suite-gate"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("gate");
  });

  test("AC11: full-suite-gate passing also emits details with kind gate", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      passed: true,
      findings: [],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("full-suite-gate"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("gate");
  });

  test("AC11 boundary: gate field in details is full-suite for full-suite-gate op", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      passed: true,
      findings: [],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("full-suite-gate"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.gate).toBe("full-suite");
  });

  test("AC11: details.failureCount equals the operation output's failureCount", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: false,
      failureCount: 5,
      findings: [],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("full-suite-gate"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.failureCount).toBe(5);
  });

  test("AC11 boundary: zero failures emits failureCount 0", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      failureCount: 0,
      findings: [],
    })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("full-suite-gate"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.failureCount).toBe(0);
  });
});

// ─── verifier details (AC14) ─────────────────────────────────────────────────

describe("verifier PhaseDetails", () => {
  test("AC14: emits details.kind='verdict' and details.passed matching operation verdict", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: false })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("verifier"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("verdict");
    expect(details?.passed).toBe(false);
  });

  test("AC14 boundary: passed:true is propagated", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("verifier"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("verdict");
    expect(details?.passed).toBe(true);
  });
});

// ─── fixStrategy details (AC15) ──────────────────────────────────────────────

describe("fixStrategy PhaseDetails", () => {
  test("AC15: fixStrategy context slice emits details.kind='fix' with strategy and findingsBefore", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({})) as any;
    const ctx = makeMockCallContext({ fixStrategy: { name: "adversarial-implementer", findingsBefore: 3 } });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("adversarial-implementer"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("fix");
    expect(details?.strategy).toBe("adversarial-implementer");
    expect(details?.findingsBefore).toBe(3);
  });

  test("AC15 boundary: fixStrategy with zero findingsBefore emits 0", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({})) as any;
    const ctx = makeMockCallContext({ fixStrategy: { name: "lint-fixer", findingsBefore: 0 } });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("lint-fixer"), {}, {}));
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("fix");
    expect(details?.findingsBefore).toBe(0);
  });
});

// ─── non-object output guard (Failure Handling: "Op output is not an object
// -> emit outcome: 'passed' with no details") ────────────────────────────────

describe("buildPhaseDetails: non-object output emits no details", () => {
  test.each(["adversarial-review", "implementer", "test-writer", "full-suite-gate", "verifier"])(
    "%s with a non-object output emits an event with no details field",
    async (opName) => {
      _storyOrchestratorDeps.callOp = (async () => "not-an-object") as any;
      const ctx = makeMockCallContext();
      const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot(opName), {}, {}));
      expect(event?.details).toBeUndefined();
    },
  );
});
