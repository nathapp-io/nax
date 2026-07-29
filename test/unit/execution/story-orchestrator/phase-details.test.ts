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
import { pipelineEventBus } from "@/pipeline";
import type { StoryPhaseCompletedEvent } from "@/pipeline/event-bus";
import type { FindingSeverity } from "@/findings";
import { makeMockCallContext } from "@test/helpers";

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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("review");
  });

  test("AC6 boundary: reviewer field is adversarial for adversarial-review op", async () => {
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput([])) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
    const bySeverity = (event?.details as Record<string, unknown> | undefined)
      ?.bySeverity as Record<string, number> | undefined;
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
    const bySeverity = (event?.details as Record<string, unknown> | undefined)
      ?.bySeverity as Record<string, number> | undefined;
    expect(bySeverity?.critical).toBe(0);
    expect(bySeverity?.error).toBe(0);
    expect(bySeverity?.warning).toBe(0);
  });

  test("AC8: blockingCount equals findings where isBlockingSeverity is true at error threshold", async () => {
    // critical and error are blocking at the default "error" threshold;
    // warning and info are advisory.
    const findings = [
      { severity: "critical" as FindingSeverity }, // blocking
      { severity: "error" as FindingSeverity },    // blocking
      { severity: "warning" as FindingSeverity },  // advisory
      { severity: "info" as FindingSeverity },     // advisory
    ];
    _storyOrchestratorDeps.callOp = (async () => makeAdversarialOutput(findings)) as any;
    const ctx = makeMockCallContext();
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("adversarial-review"), {}, {}),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.blockingCount).toBe(0);
    expect(details?.advisoryCount).toBe(3);
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("full-suite-gate"), {}, {}),
    );
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("full-suite-gate"), {}, {}),
    );
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
    const event = await capturePhaseEvent(() =>
      runPhase(ctx, makeSlot("full-suite-gate"), {}, {}),
    );
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.gate).toBe("full-suite");
  });
});
