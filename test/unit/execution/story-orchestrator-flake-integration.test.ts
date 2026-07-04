/**
 * Flake-Triage Integration into Full-Suite Gate — US-003
 *
 * Story: a flaky pre-existing test in the target repo currently burns real
 * money and time — nax attributes the intermittent failure to the agent's
 * change, dispatches rectification fix cycles, escalates model tiers, and can
 * fail the regression gate — all for a failure the story did not cause.
 *
 * Wires `triageFlakyFindings` (from src/verification/flake-triage.ts) into
 * the story-orchestrator's rectification path. After the full-suite gate
 * produces `failed-test` findings, triage runs ONCE before rectification
 * gathers findings. Findings relabeled to `flaky-test` are quarantined for the
 * run; only `failed-test` findings feed the fix cycle. `gateFailureKeys` and
 * `gateRegressedAfterRectification` exclude `flaky-test` keys so the
 * phase-regression comparisons ignore quarantined flakes.
 *
 * Triage is invoked via the `_storyOrchestratorDeps.triage` injectable seam
 * — production wires it to the real `triageFlakyFindings`; tests stub it to
 * observe ordering, input shape, and downstream filtering without spinning up
 * subprocesses.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import { StoryOrchestratorBuilder, _storyOrchestratorDeps } from "@/execution";
import { gateFailureKeys, gateRegressedAfterRectification } from "@/execution";
import type { Finding, FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime } from "@test/helpers";

const testSel = pickSelector("flake-triage-integration", "execution");

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

const GATE_NAME = "full-suite-gate";

function makeGateOp(): RunOperation<
  { story: string },
  { success: boolean; findings: Finding[] },
  typeof DEFAULT_CONFIG
> {
  return {
    kind: "run",
    name: GATE_NAME,
    stage: "verify",
    config: testSel,
    session: { role: "verifier", lifetime: "fresh" },
    build: () => ({
      role: { id: "r", content: "gate", overridable: false },
      task: { id: "t", content: "", overridable: false },
    }),
    parse: () => ({ success: false, findings: [] }),
  };
}

function makeFailedTest(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "shouldBar",
    file: "test/unit/foo.test.ts",
    message: "expected x to equal y",
    ...overrides,
  };
}

function makeFlakyTest(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "flaky-test",
    rule: "shouldBar",
    file: "test/unit/foo.test.ts",
    message: "expected x to equal y",
    ...overrides,
  };
}

function makeCtx(): { ctx: CallContext; runtime: NaxRuntime } {
  const runtime = makeTestRuntime();
  return {
    runtime,
    ctx: {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-003",
    } as unknown as CallContext,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps — restore in afterEach so test ordering cannot leak state.
// ─────────────────────────────────────────────────────────────────────────────

let savedCallOp: typeof _storyOrchestratorDeps.callOp;
let savedRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let savedTriage: unknown;
let savedCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  savedCallOp = _storyOrchestratorDeps.callOp;
  savedRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  savedCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  savedTriage = (_storyOrchestratorDeps as Record<string, unknown>).triage;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
  resetLogger();
  initLogger({ level: "silent" });
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = savedCallOp;
  _storyOrchestratorDeps.runFixCycle = savedRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = savedCaptureGitRef;
  if (savedTriage === undefined) {
    (_storyOrchestratorDeps as Record<string, unknown>).triage = undefined;
  } else {
    (_storyOrchestratorDeps as Record<string, unknown>).triage = savedTriage;
  }
  resetLogger();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — triage runs ONCE with the gate's failed-test findings, BEFORE
// gatherRectificationFindings reads them.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: triage runs once with gate failed-test findings before gatherRectificationFindings", () => {
  test("triage is invoked exactly once with the gate's failed-test findings, before the fix cycle is seeded", async () => {
    const callOrder: string[] = [];
    const triageInputs: Finding[][] = [];

    const triageStub = mock((gateFindings: Finding[]) => {
      callOrder.push("triage");
      triageInputs.push([...gateFindings]);
      // Pass through (no relabel) so the fix cycle sees them as failed-test.
      const out: Finding[] = gateFindings.map((f) => ({ ...f }));
      return [out, { quarantinedKeys: [] as string[] }];
    });
    (_storyOrchestratorDeps as Record<string, unknown>).triage = triageStub;

    const gateFinding = makeFailedTest({ file: "test/foo.test.ts", rule: "shouldBar" });

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === GATE_NAME) {
        return { success: false, findings: [gateFinding] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      callOrder.push("runFixCycle");
      capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const { ctx } = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-003" } })
      .addFullSuiteGate({ op: makeGateOp(), input: { story: "US-003" } })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx, { isThreeSession: true });
    await plan.run();

    expect(triageStub.mock.calls.length).toBe(1);
    expect(callOrder.indexOf("triage")).toBeLessThan(callOrder.indexOf("runFixCycle"));
    // The single triage call must receive the gate's failed-test findings.
    expect(triageInputs[0]?.length).toBe(1);
    expect(triageInputs[0]?.[0]).toMatchObject({
      category: "failed-test",
      file: "test/foo.test.ts",
      rule: "shouldBar",
    });
    // The fix cycle must see the gate's failed-test finding (triage passed it through).
    expect(capturedCycle).not.toBeNull();
    const cycleFindings = (capturedCycle as unknown as FixCycle<Finding>).findings;
    expect(cycleFindings.some((f) => f.source === "test-runner" && f.file === "test/foo.test.ts")).toBe(true);
  });

  test("triage is NOT invoked when the gate passes", async () => {
    const triageStub = mock(() => [[], { quarantinedKeys: [] as string[] }] as const);
    (_storyOrchestratorDeps as Record<string, unknown>).triage = triageStub;

    _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;

    const { ctx } = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-003" } })
      .addFullSuiteGate({ op: makeGateOp(), input: { story: "US-003" } })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx, { isThreeSession: true });
    await plan.run();

    expect(triageStub.mock.calls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — triage relabels every gate failure to flaky-test → no fix cycle for
// that gate, one warn log per quarantined test, story passes.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2: all-flaky triage → no fix cycle, one warn per quarantined test, story passes", () => {
  test("when triage relabels all gate failures to flaky-test, runFixCycle is not invoked and a warning is recorded per quarantined test", async () => {
    const quarantinedKeyA = "test/unit/a.test.ts::shouldA";
    const quarantinedKeyB = "test/unit/b.test.ts::shouldB";

    const triageStub = mock((gateFindings: Finding[]) => {
      const flaky = gateFindings.map((f) => ({ ...f, category: "flaky-test" }));
      return [flaky, { quarantinedKeys: [quarantinedKeyA, quarantinedKeyB] }] as const;
    });
    (_storyOrchestratorDeps as Record<string, unknown>).triage = triageStub;

    const gateFindings: Finding[] = [
      makeFailedTest({ file: "test/unit/a.test.ts", rule: "shouldA" }),
      makeFailedTest({ file: "test/unit/b.test.ts", rule: "shouldB" }),
    ];

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === GATE_NAME) {
        return { success: false, findings: gateFindings };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let fixCycleCalls = 0;
    _storyOrchestratorDeps.runFixCycle = mock(async () => {
      fixCycleCalls += 1;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const warnSpy = spyOn(getLogger(), "warn");

    const { ctx } = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-003" } })
      .addFullSuiteGate({ op: makeGateOp(), input: { story: "US-003" } })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx, { isThreeSession: true });
    const result = await plan.run();

    expect(fixCycleCalls).toBe(0);
    // One warn per quarantined test, both keyed by `${file}::${testName}` and tagged with storyId.
    const quarantineWarns = warnSpy.mock.calls.filter((c) => String(c[1]).includes("quarantined"));
    expect(quarantineWarns.length).toBe(2);
    const quarantineKeys = quarantineWarns.map((c) => {
      const data = c[2] as { key?: string } | undefined;
      return data?.key ?? "";
    });
    expect(quarantineKeys).toContain(quarantinedKeyA);
    expect(quarantineKeys).toContain(quarantinedKeyB);
    for (const call of quarantineWarns) {
      const data = call[2] as { storyId?: string } | undefined;
      expect(data?.storyId).toBe("US-003");
    }
    // No unfixed findings — quarantine cleared the gate.
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — triage returns a mix of flaky-test and failed-test → fix cycle
// receives only the failed-test findings.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3: mixed triage → fix cycle receives only failed-test findings", () => {
  test("when triage returns a mix, the fix cycle's initial findings list contains only failed-test entries", async () => {
    const triageStub = mock((gateFindings: Finding[]) => {
      // Mark every other finding as flaky; leave the rest as failed-test.
      const triaged = gateFindings.map((f, i) => (i % 2 === 0 ? { ...f, category: "flaky-test" } : { ...f }));
      const keys = triaged.filter((f) => f.category === "flaky-test").map((f) => `${f.file}::${f.rule}`);
      return [triaged, { quarantinedKeys: keys }] as const;
    });
    (_storyOrchestratorDeps as Record<string, unknown>).triage = triageStub;

    const gateFindings: Finding[] = [
      makeFailedTest({ file: "test/unit/a.test.ts", rule: "shouldA" }),
      makeFailedTest({ file: "test/unit/b.test.ts", rule: "shouldB" }),
      makeFailedTest({ file: "test/unit/c.test.ts", rule: "shouldC" }),
      makeFailedTest({ file: "test/unit/d.test.ts", rule: "shouldD" }),
    ];

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === GATE_NAME) {
        return { success: false, findings: gateFindings };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      // Capture only the FIRST cycle — the post-rectification resume's
      // second pass re-runs the gate (overwriting the triaged output) and
      // dispatches a fresh cycle whose findings are an un-triaged re-run.
      // AC3 asserts the triage-induced filtering on the first cycle.
      if (capturedCycle === null) capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const { ctx } = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-003" } })
      .addFullSuiteGate({ op: makeGateOp(), input: { story: "US-003" } })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx, { isThreeSession: true });
    await plan.run();

    expect(capturedCycle).not.toBeNull();
    const cycleFindings = (capturedCycle as unknown as FixCycle<Finding>).findings;
    // Exactly 2 failed-test findings reach the cycle (indices 1 and 3).
    expect(cycleFindings.length).toBe(2);
    for (const f of cycleFindings) {
      expect(f.category).toBe("failed-test");
    }
    const files = cycleFindings.map((f) => f.file).sort();
    expect(files).toEqual(["test/unit/b.test.ts", "test/unit/d.test.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — gateFailureKeys excludes findings categorized as flaky-test.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC4: gateFailureKeys excludes flaky-test findings", () => {
  test("flaky-test findings are not present in the returned key set", () => {
    const out = {
      success: false,
      findings: [
        makeFlakyTest({ file: "test/unit/flaky.test.ts", rule: "shouldQuarantine" }),
        makeFailedTest({ file: "test/unit/real.test.ts", rule: "shouldReal" }),
      ],
    };
    const keys = gateFailureKeys(out);
    expect(keys.has("test/unit/flaky.test.ts::shouldQuarantine")).toBe(false);
    expect(keys.has("test/unit/real.test.ts::shouldReal")).toBe(true);
    expect(keys.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — gateRegressedAfterRectification ignores flaky-test key differences.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC5: gateRegressedAfterRectification ignores flaky-test diffs", () => {
  test("returns false when the only diff between baseline and final is flaky-test entries", () => {
    const baseline = new Set(["test/unit/real.test.ts::shouldReal"]);
    const finalGateOutput = {
      success: false,
      findings: [
        // New flaky-test entry that was NOT in the baseline — must NOT count as regression.
        makeFlakyTest({ file: "test/unit/flaky.test.ts", rule: "shouldQuarantine" }),
        // Pre-existing failed-test still present in baseline.
        makeFailedTest({ file: "test/unit/real.test.ts", rule: "shouldReal" }),
      ],
    };
    expect(gateRegressedAfterRectification(finalGateOutput, baseline, GATE_NAME, "US-003")).toBe(false);
  });

  test("still reports regression when a NEW failed-test key appears alongside a flaky diff", () => {
    const baseline = new Set(["test/unit/real.test.ts::shouldReal"]);
    const finalGateOutput = {
      success: false,
      findings: [
        makeFlakyTest({ file: "test/unit/flaky.test.ts", rule: "shouldQuarantine" }),
        makeFailedTest({ file: "test/unit/real.test.ts", rule: "shouldReal" }),
        // New structured failure — must drive regression even with the flaky diff.
        makeFailedTest({ file: "test/unit/newlybroken.test.ts", rule: "shouldNew" }),
      ],
    };
    expect(gateRegressedAfterRectification(finalGateOutput, baseline, GATE_NAME, "US-003")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — quarantine decision is logged with storyId and `${file}::${testName}` key.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC6: quarantine decision log entry includes storyId and the quarantined key", () => {
  test("exactly one warn is emitted per quarantined test, each carrying storyId and key", async () => {
    const keyA = "test/unit/a.test.ts::shouldA";
    const keyB = "test/unit/b.test.ts::shouldB";

    const triageStub = mock((gateFindings: Finding[]) => {
      const flaky = gateFindings.map((f) => ({ ...f, category: "flaky-test" }));
      return [flaky, { quarantinedKeys: [keyA, keyB] }] as const;
    });
    (_storyOrchestratorDeps as Record<string, unknown>).triage = triageStub;

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === GATE_NAME) {
        return {
          success: false,
          findings: [
            makeFailedTest({ file: "test/unit/a.test.ts", rule: "shouldA" }),
            makeFailedTest({ file: "test/unit/b.test.ts", rule: "shouldB" }),
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;

    const warnSpy = spyOn(getLogger(), "warn");
    const { ctx } = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-003" } })
      .addFullSuiteGate({ op: makeGateOp(), input: { story: "US-003" } })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx, { isThreeSession: true });
    await plan.run();

    const quarantineWarns = warnSpy.mock.calls.filter((c) => String(c[1]).includes("quarantined"));
    expect(quarantineWarns.length).toBe(2);
    const entries = quarantineWarns.map((c) => ({
      stage: c[0] as string,
      message: c[1] as string,
      data: c[2] as { storyId?: string; key?: string } | undefined,
    }));
    for (const e of entries) {
      expect(e.data?.storyId).toBe("US-003");
      expect(typeof e.data?.key).toBe("string");
      // Key must match `${file}::${testName}`.
      expect(e.data?.key).toMatch(/::.+/);
    }
    const keys = entries.map((e) => e.data?.key);
    expect(keys).toContain(keyA);
    expect(keys).toContain(keyB);
  });
});
