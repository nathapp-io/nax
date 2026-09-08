import { describe, expect, test } from "bun:test";
import type { ReviewAuditDecision, ReviewAuditDispatch } from "@/review/review-audit";
import type { ReviewDecisionEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachReviewAuditSubscriber } from "@/runtime/middleware/review-audit";

const PERMS = { mode: "approve-reads" as const };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-s1-reviewer-semantic",
    sessionRole: "reviewer-semantic",
    prompt: "Review this",
    response: JSON.stringify({ passed: true, findings: [] }),
    agentName: "claude",
    stage: "review",
    storyId: "US-001",
    featureName: "feat",
    workdir: "/tmp/w",
    projectDir: "/tmp/p",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "agent-run",
    protocolIds: { sessionId: "sid-1", recordId: "rid-1" },
    origin: "runAsSession",
    durationMs: 150,
    timestamp: 1000,
    ...overrides,
  };
}

describe("attachReviewAuditSubscriber", () => {
  test("captures semantic reviewer session metadata", () => {
    const recorded: ReviewAuditDispatch[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      { recordDispatch: (e) => recorded.push(e), recordDecision() {}, getAdvisoryFindings: () => [], async flush() {} },
      "run-1",
    );

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].reviewer).toBe("semantic");
    expect(recorded[0].sessionName).toBe("nax-abc-feat-s1-reviewer-semantic");
    expect(recorded[0].sessionId).toBe("sid-1");
    expect(recorded[0].recordId).toBe("rid-1");
    expect(recorded[0].storyId).toBe("US-001");
    expect(recorded[0].featureName).toBe("feat");
  });

  test("captures adversarial reviewer session metadata", () => {
    const recorded: ReviewAuditDispatch[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      { recordDispatch: (e) => recorded.push(e), recordDecision() {}, getAdvisoryFindings: () => [], async flush() {} },
      "run-1",
    );

    bus.emitDispatch(
      makeSessionTurnEvent({
        sessionName: "nax-abc-feat-s1-reviewer-adversarial",
        sessionRole: "reviewer-adversarial",
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].reviewer).toBe("adversarial");
  });

  test("ignores non-review session roles", () => {
    const recorded: ReviewAuditDispatch[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      { recordDispatch: (e) => recorded.push(e), recordDecision() {}, getAdvisoryFindings: () => [], async flush() {} },
      "run-1",
    );

    bus.emitDispatch(makeSessionTurnEvent({ sessionRole: "implementer" }));

    expect(recorded).toHaveLength(0);
  });

  test("forwards review-decision events to auditor.recordDecision", () => {
    const decisions: ReviewAuditDecision[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      {
        recordDispatch() {},
        recordDecision: (e) => decisions.push(e),
        getAdvisoryFindings: () => [],
        async flush() {},
      },
      "run-1",
    );

    const event: ReviewDecisionEvent = {
      kind: "review-decision",
      reviewer: "adversarial",
      storyId: "US-002",
      featureName: "feat",
      workdir: "/tmp/w",
      projectDir: "/tmp/p",
      timestamp: 9000,
      parsed: true,
      passed: false,
      result: { passed: false, findings: [{ severity: "error", message: "missing check" }] },
    };
    bus.emitReviewDecision(event);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].reviewer).toBe("adversarial");
    expect(decisions[0].storyId).toBe("US-002");
    expect(decisions[0].parsed).toBe(true);
    expect(decisions[0].passed).toBe(false);
  });

  // US-002 — AC7: the audit subscriber forwards modelPassed from the dispatched
  // event onto the decision the writer consumes, matching how blockingThreshold
  // is forwarded. Without this, the persisted audit JSON never sees the field.
  test("forwards modelPassed from the dispatched event to the decision", () => {
    const decisions: ReviewAuditDecision[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      {
        recordDispatch() {},
        recordDecision: (e) => decisions.push(e),
        getAdvisoryFindings: () => [],
        async flush() {},
      },
      "run-1",
    );

    const event: ReviewDecisionEvent = {
      kind: "review-decision",
      reviewer: "adversarial",
      timestamp: 9000,
      parsed: true,
      passed: true,
      modelPassed: false,
      result: { passed: true, findings: [] },
    };
    bus.emitReviewDecision(event);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].modelPassed).toBe(false);
  });

  // US-002 — adversarial-review finding: the headline scenario drives the full
  // event→decision→audit pipeline. Verdict flips to passed:true at the emit seam
  // (nax#1378 sub-threshold), modelPassed stays false. The audit record must
  // carry the modelPassed value, not the framework's flipped verdict.
  test("AC6 (end-to-end): an event with passed:true + modelPassed:false reaches the decision with modelPassed:false", () => {
    const decisions: ReviewAuditDecision[] = [];
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(
      bus,
      {
        recordDispatch() {},
        recordDecision: (e) => decisions.push(e),
        getAdvisoryFindings: () => [],
        async flush() {},
      },
      "run-1",
    );

    const event: ReviewDecisionEvent = {
      kind: "review-decision",
      reviewer: "adversarial",
      timestamp: 9000,
      parsed: true,
      passed: true,
      modelPassed: false,
      result: { passed: true, findings: [] },
    };
    bus.emitReviewDecision(event);

    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    expect(decision.passed).toBe(true); // framework's flipped verdict
    expect(decision.modelPassed).toBe(false); // model-claimed failure — preserved
  });

  test("unsubscribing stops review-decision forwarding", () => {
    const decisions: ReviewAuditDecision[] = [];
    const bus = new DispatchEventBus();
    const off = attachReviewAuditSubscriber(
      bus,
      {
        recordDispatch() {},
        recordDecision: (e) => decisions.push(e),
        getAdvisoryFindings: () => [],
        async flush() {},
      },
      "run-1",
    );

    const event: ReviewDecisionEvent = {
      kind: "review-decision",
      reviewer: "semantic",
      timestamp: 1000,
      parsed: false,
      result: null,
    };
    bus.emitReviewDecision(event);
    off();
    bus.emitReviewDecision(event);

    expect(decisions).toHaveLength(1);
  });
});
