/**
 * runPhase — phase telemetry context and detail payloads (US-003)
 *
 * AC1–AC5:  phaseTelemetry slice propagation (testStrategy, sessionModel, tier)
 * AC6–AC8, AC16: adversarial-review PhaseDetails arm
 * AC9–AC11: implementer PhaseDetails arm
 * AC12: test-writer PhaseDetails arm
 * AC13: full-suite-gate PhaseDetails arm
 * AC14: verifier PhaseDetails arm
 * AC15: fixStrategy context slice → kind:"fix" details
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallContext } from "@/operations";
import { pipelineEventBus, type StoryPhaseCompletedEvent } from "@/pipeline";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { recordAdversarialIteration } from "@/review";

type AnyOp = Parameters<typeof _storyOrchestratorDeps.callOp>[1];

function makeOp(name: string): AnyOp {
  return {
    name,
    stage: "verify",
    kind: "run",
    config: [],
    build: () => ({ prompt: "" }),
    parse: () => ({}),
  } as unknown as AnyOp;
}

function makeSlot(opName: string) {
  return { op: makeOp(opName), input: {} };
}

function collectPhaseEvents(): { events: StoryPhaseCompletedEvent[]; unsub: () => void } {
  const events: StoryPhaseCompletedEvent[] = [];
  const unsub = pipelineEventBus.on("story:phase:completed", (e) => events.push(e));
  return { events, unsub };
}

const origCallOp = _storyOrchestratorDeps.callOp;
const origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  pipelineEventBus.clear();
  _storyOrchestratorDeps.captureGitRef = async () => "abc1234";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  pipelineEventBus.clear();
});

// ─── AC1-5: phaseTelemetry propagation ───────────────────────────────────────

describe("runPhase — phaseTelemetry propagation", () => {
  test("AC1: three-session-tdd emits sessionModel 'three-session'", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/x",
      agentName: "claude",
      storyId: "s1",
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]?.sessionModel).toBe("three-session");
    unsub();
  });

  test("AC1: boundary — absent phaseTelemetry emits no sessionModel", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "s1",
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]).not.toHaveProperty("sessionModel");
    unsub();
  });

  test("AC2: three-session-tdd propagates testStrategy field", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "s1",
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]?.testStrategy).toBe("three-session-tdd");
    unsub();
  });

  test("AC3: no-test emits sessionModel 'single-session'", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "s1",
      phaseTelemetry: { testStrategy: "no-test", sessionModel: "single-session", tier: "balanced" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]?.sessionModel).toBe("single-session");
    unsub();
  });

  test("AC4: tier is propagated from phaseTelemetry", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "s1",
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "powerful" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]?.tier).toBe("powerful");
    unsub();
  });

  test("AC4: boundary — tier 'balanced' propagated faithfully", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "s1",
      phaseTelemetry: { testStrategy: "no-test", sessionModel: "single-session", tier: "balanced" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("implementer"), {}, {});
    expect(events[0]?.tier).toBe("balanced");
    unsub();
  });

  test("AC5: phaseTelemetry survives FixCycleContext hop — sessionModel preserved on emitted event", async () => {
    // FixCycleContext = CallContext & { storyId: string }; the phaseTelemetry slice
    // must survive structural reuse when rectification calls runPhase via wrappedCallOp.
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const cycleCtx: CallContext & { readonly storyId: string } = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "fix-cycle-story",
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(cycleCtx, makeSlot("implementer"), {}, {});
    expect(events[0]?.sessionModel).toBe("three-session");
    unsub();
  });
});

// ─── AC6-8, AC16: adversarial-review PhaseDetails arm ────────────────────────

describe("runPhase — adversarial-review details", () => {
  function makeAdvCtx(overrides: Partial<CallContext> = {}): CallContext {
    const runtime = makeTestRuntime();
    return {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "adv-story",
      ...overrides,
    } as CallContext;
  }

  test("AC6: details.iteration equals number of prior adversarial completions for the story", async () => {
    const ctx = makeAdvCtx();
    // seed two completed rounds before this invocation
    recordAdversarialIteration(ctx.runtime.adversarialIterations, "adv-story", []);
    recordAdversarialIteration(ctx.runtime.adversarialIterations, "adv-story", []);
    _storyOrchestratorDeps.callOp = async () => ({ normalizedFindings: [], advisoryFindings: [] } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.iteration).toBe(2);
    unsub();
  });

  test("AC6: boundary — first run (no prior iterations) emits iteration 0", async () => {
    const ctx = makeAdvCtx();
    _storyOrchestratorDeps.callOp = async () => ({ normalizedFindings: [], advisoryFindings: [] } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.iteration).toBe(0);
    unsub();
  });

  test("AC7: details.bySeverity counts all FindingSeverity keys matching normalized findings", async () => {
    const ctx = makeAdvCtx();
    _storyOrchestratorDeps.callOp = async () => ({
      normalizedFindings: [
        { severity: "error", source: "adversarial-review", message: "e1" },
        { severity: "error", source: "adversarial-review", message: "e2" },
        { severity: "warning", source: "adversarial-review", message: "w1" },
        { severity: "critical", source: "adversarial-review", message: "c1" },
      ],
      advisoryFindings: [],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const by = (events[0]?.details as Record<string, Record<string, number>> | undefined)?.bySeverity;
    expect(by?.error).toBe(2);
    expect(by?.warning).toBe(1);
    expect(by?.critical).toBe(1);
    expect(by?.info).toBe(0);
    expect(by?.low).toBe(0);
    expect(by?.unverifiable).toBe(0);
    unsub();
  });

  test("AC7: boundary — empty findings produces all-zero bySeverity", async () => {
    const ctx = makeAdvCtx();
    _storyOrchestratorDeps.callOp = async () => ({ normalizedFindings: [], advisoryFindings: [] } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const by = (events[0]?.details as Record<string, Record<string, number>> | undefined)?.bySeverity;
    expect(by?.error).toBe(0);
    expect(by?.warning).toBe(0);
    expect(by?.critical).toBe(0);
    unsub();
  });

  test("AC8: blockingCount uses configured blockingThreshold 'warning', not 'error' default", async () => {
    // warnings are blocking at "warning" threshold but NOT at the default "error" threshold.
    // The op's verify() must persist blockingThreshold onto the output so buildPhaseDetails reads it.
    // Until verify() persists it, the output won't carry blockingThreshold and this test fails.
    const ctx = makeAdvCtx();
    _storyOrchestratorDeps.callOp = async () => ({
      normalizedFindings: [
        { severity: "warning", source: "adversarial-review", message: "w1" },
        { severity: "warning", source: "adversarial-review", message: "w2" },
        { severity: "info", source: "adversarial-review", message: "i1" },
      ],
      advisoryFindings: [],
      blockingThreshold: "warning",
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    // at "warning" threshold: 2 warnings are blocking, 1 info is advisory
    expect(details?.blockingCount).toBe(2);
    expect(details?.advisoryCount).toBe(1);
    unsub();
  });

  test("AC8: boundary — error findings at 'warning' threshold also block", async () => {
    const ctx = makeAdvCtx();
    _storyOrchestratorDeps.callOp = async () => ({
      normalizedFindings: [
        { severity: "error", source: "adversarial-review", message: "e1" },
        { severity: "warning", source: "adversarial-review", message: "w1" },
      ],
      advisoryFindings: [],
      blockingThreshold: "warning",
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.blockingCount).toBe(2);
    expect(details?.advisoryCount).toBe(0);
    unsub();
  });

  test("AC16: verbose detail populates details.items with finding messages", async () => {
    const config = makeNaxConfig({ reporters: { otel: { detail: "verbose" } } });
    const runtime = makeTestRuntime({ config });
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "verbose-story",
    };
    _storyOrchestratorDeps.callOp = async () => ({
      normalizedFindings: [
        { severity: "error", source: "adversarial-review", message: "missing-null-check" },
        { severity: "warning", source: "adversarial-review", message: "unused-variable" },
      ],
      advisoryFindings: [],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    const items = details?.items as Array<{ message: string }> | undefined;
    expect(items).toBeDefined();
    expect(items?.map((i) => i.message)).toContain("missing-null-check");
    expect(items?.map((i) => i.message)).toContain("unused-variable");
    unsub();
  });

  test("AC16: boundary — counts detail (default) omits items", async () => {
    const ctx = makeAdvCtx(); // default detail = "counts"
    _storyOrchestratorDeps.callOp = async () => ({
      normalizedFindings: [{ severity: "error", source: "adversarial-review", message: "x" }],
      advisoryFindings: [],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-review"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details).not.toHaveProperty("items");
    unsub();
  });
});

// ─── AC9-11: implementer PhaseDetails arm ────────────────────────────────────

describe("runPhase — implementer details", () => {
  function makeImplCtx(): CallContext {
    const runtime = makeTestRuntime();
    return {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "impl-story",
    };
  }

  test("AC9: three-session implementer emits details.isolationPassed equal to operation result", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      isolation: { passed: false, violations: ["src/x.ts"] },
      filesChanged: ["src/x.ts"],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.isolationPassed).toBe(false);
    unsub();
  });

  test("AC9: boundary — isolation.passed true is propagated", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      isolation: { passed: true, violations: [] },
      filesChanged: ["src/a.ts"],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.isolationPassed).toBe(true);
    unsub();
  });

  test("AC10: single-session implementer emits details without isolationPassed field", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      filesChanged: ["src/a.ts"],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, false);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(details ?? {}, "isolationPassed")).toBe(false);
    unsub();
  });

  test("AC10: boundary — single-session details still carry kind and role", async () => {
    _storyOrchestratorDeps.callOp = async () => ({ filesChanged: [] } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, false);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("authoring");
    expect(details?.role).toBe("implementer");
    unsub();
  });

  test("AC11: details.filesChanged equals operation output file count", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts"],
      isolation: { passed: true, violations: [] },
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(3);
    unsub();
  });

  test("AC11: boundary — zero files changed emits filesChanged 0", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      filesChanged: [],
      isolation: { passed: true, violations: [] },
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeImplCtx(), makeSlot("implementer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(0);
    unsub();
  });
});

// ─── AC12-15: other operation PhaseDetails arms ───────────────────────────────

describe("runPhase — other operation detail arms", () => {
  function makeBaseCtx(): CallContext {
    const runtime = makeTestRuntime();
    return {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "base-story",
    };
  }

  test("AC12: test-writer emits details.kind='authoring' and details.role='test-writer'", async () => {
    _storyOrchestratorDeps.callOp = async () => ({ filesChanged: ["test/foo.test.ts"] } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("test-writer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("authoring");
    expect(details?.role).toBe("test-writer");
    unsub();
  });

  test("AC12: boundary — test-writer filesChanged is counted", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      filesChanged: ["test/a.test.ts", "test/b.test.ts"],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("test-writer"), {}, {}, true);
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.filesChanged).toBe(2);
    unsub();
  });

  test("AC13: full-suite-gate emits details.kind='gate' and details.failureCount from output", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      success: false,
      failureCount: 5,
      findings: [],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("full-suite-gate"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("gate");
    expect(details?.failureCount).toBe(5);
    unsub();
  });

  test("AC13: boundary — zero failures emits failureCount 0", async () => {
    _storyOrchestratorDeps.callOp = async () => ({
      success: true,
      failureCount: 0,
      findings: [],
    } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("full-suite-gate"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.failureCount).toBe(0);
    unsub();
  });

  test("AC14: verifier emits details.kind='verdict' and details.passed matching operation verdict", async () => {
    _storyOrchestratorDeps.callOp = async () => ({ passed: false } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("verifier"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("verdict");
    expect(details?.passed).toBe(false);
    unsub();
  });

  test("AC14: boundary — verifier passed:true is propagated", async () => {
    _storyOrchestratorDeps.callOp = async () => ({ passed: true } as never);
    const { events, unsub } = collectPhaseEvents();
    await runPhase(makeBaseCtx(), makeSlot("verifier"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("verdict");
    expect(details?.passed).toBe(true);
    unsub();
  });

  test("AC15: fixStrategy context slice emits details.kind='fix' with strategy and findingsBefore", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "fix-story",
      fixStrategy: { name: "adversarial-implementer", findingsBefore: 3 },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("adversarial-implementer"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("fix");
    expect(details?.strategy).toBe("adversarial-implementer");
    expect(details?.findingsBefore).toBe(3);
    unsub();
  });

  test("AC15: boundary — fixStrategy with zero findingsBefore emits 0", async () => {
    _storyOrchestratorDeps.callOp = async () => ({} as never);
    const runtime = makeTestRuntime();
    const ctx: CallContext = {
      runtime, packageView: runtime.packages.repo(), packageDir: "/tmp/x",
      agentName: "claude", storyId: "fix-story-2",
      fixStrategy: { name: "lint-fixer", findingsBefore: 0 },
    };
    const { events, unsub } = collectPhaseEvents();
    await runPhase(ctx, makeSlot("lint-fixer"), {}, {});
    const details = events[0]?.details as Record<string, unknown> | undefined;
    expect(details?.kind).toBe("fix");
    expect(details?.findingsBefore).toBe(0);
    unsub();
  });
});
