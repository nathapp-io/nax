/**
 * Unit tests for the deferred-regression ↔ flake-triage integration.
 *
 * Covers AC1–AC6 from the "Integrate flaky triage into deferred regression"
 * story: triage is wired into the deferred regression gate, flakes are
 * excluded from story attribution / fix-cycle dispatch, and the shared
 * run-scoped memo short-circuits re-probing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _regressionDeps, runDeferredRegression } from "@/execution";
import type { DeferredRegressionOptions } from "@/execution";
import type { Finding } from "@/findings/types";
import type { VerificationResult } from "@/verification";
import type { QuarantineMemo } from "@/verification/flake-triage";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";

function makeVerifyResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    success: false,
    status: "TEST_FAILURE",
    countsTowardEscalation: true,
    output: "92 fail | 0 pass\n(fail) some test",
    passCount: 0,
    failCount: 92,
    ...overrides,
  };
}

function makePrd(storyIds: string[]): { userStories: { id: string; status: string; title: string }[] } {
  return {
    userStories: storyIds.map((id) => ({ id, status: "passed", title: id })),
  };
}

const TEST_CONFIG = makeNaxConfig({
  quality: {
    commands: { test: "bun test" },
    forceExit: false,
    detectOpenHandles: false,
    detectOpenHandlesRetries: 0,
    gracePeriodMs: 0,
    drainTimeoutMs: 0,
    shell: false,
    stripEnvVars: [],
  },
  execution: {
    regressionGate: {
      mode: "deferred",
      timeoutSeconds: 60,
      acceptOnTimeout: true,
    },
  },
});

function makeOptions(opts: {
  storyIds: string[];
  quarantineMemo?: QuarantineMemo;
}): DeferredRegressionOptions {
  return {
    config: TEST_CONFIG,
    prd: makePrd(opts.storyIds) as unknown as DeferredRegressionOptions["prd"],
    workdir: "/tmp/test-workdir",
    runtime: makeMockRuntime(),
    ...(opts.quarantineMemo ? { quarantineMemo: opts.quarantineMemo } : {}),
  } as unknown as DeferredRegressionOptions;
}

let savedDeps: typeof _regressionDeps;
beforeEach(() => {
  savedDeps = { ..._regressionDeps };
});
afterEach(() => {
  Object.assign(_regressionDeps, savedDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — triage is invoked with the failed-test findings on regression failure
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — triage wiring (AC1)", () => {
  test("AC1 — invokes triage with the failed-test findings when the regression suite fails", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [
        { file: "a.test.ts", testName: "test a", error: "boom", stackTrace: [] },
        { file: "b.test.ts", testName: "test b", error: "boom", stackTrace: [] },
      ],
    }));

    const triageCalls: Finding[][] = [];
    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => {
      triageCalls.push([...input.findings]);
      return {
        findings: input.findings.map((f) => ({ ...f })),
        quarantineReport: { keys: [], reasons: [] },
      };
    });
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    }));

    await runDeferredRegression(makeOptions({ storyIds: ["US-001"] }));

    expect(triageCalls.length).toBeGreaterThan(0);
    const failedTestFindings = triageCalls[0]?.filter((f) => f.category === "failed-test") ?? [];
    expect(failedTestFindings.length).toBeGreaterThan(0);
    for (const f of failedTestFindings) {
      expect(f.source).toBe("test-runner");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — every failure relabeled flaky-test → success with quarantine warnings
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — all flakes (AC2)", () => {
  test("AC2 — returns success=true and reports quarantined keys as warnings when every failure is flaky", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [
        { file: "a.test.ts", testName: "test a", error: "boom", stackTrace: [] },
        { file: "b.test.ts", testName: "test b", error: "boom", stackTrace: [] },
      ],
    }));

    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => ({
      findings: input.findings.map((f) => ({ ...f, category: "flaky-test" })),
      quarantineReport: {
        keys: ["a.test.ts::test a", "b.test.ts::test b"],
        reasons: ["quarantined: a.test.ts::test a", "quarantined: b.test.ts::test b"],
      },
    }));
    const fixCycleCalls: number[] = [];
    _regressionDeps.runFixCycle = mock(async () => {
      fixCycleCalls.push(1);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });

    const result = await runDeferredRegression(makeOptions({ storyIds: ["US-001", "US-002"] }));

    expect(result.success).toBe(true);
    expect(fixCycleCalls).toHaveLength(0);
    expect(result.quarantineReport?.keys).toEqual(["a.test.ts::test a", "b.test.ts::test b"]);
    expect(result.quarantineReport?.reasons.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — flaky-test findings do not attribute stories or dispatch fix cycles
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — flaky tests excluded from attribution (AC3)", () => {
  test("AC3 — flaky-test findings produce no affected stories and no fix cycles", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "a.test.ts", testName: "test a", error: "boom", stackTrace: [] }],
    }));

    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => ({
      findings: input.findings.map((f) => ({ ...f, category: "flaky-test" })),
      quarantineReport: { keys: ["a.test.ts::test a"], reasons: ["quarantined: a.test.ts::test a"] },
    }));
    let fixCycleCalls = 0;
    _regressionDeps.runFixCycle = mock(async () => {
      fixCycleCalls += 1;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });

    const result = await runDeferredRegression(makeOptions({ storyIds: ["US-001"] }));

    expect(result.affectedStories).toEqual([]);
    expect(fixCycleCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — one genuine + one flake → exactly one per-story fix cycle
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — genuine vs flake (AC4)", () => {
  test("AC4 — dispatches exactly one fix cycle for the story attributed to the genuine failure", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [
        { file: "flaky.test.ts", testName: "flaky one", error: "boom", stackTrace: [] },
        { file: "real.test.ts", testName: "real one", error: "boom", stackTrace: [] },
      ],
    }));

    // Triage relabels only the flaky test.
    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => ({
      findings: input.findings.map((f) =>
        f.file === "flaky.test.ts" && f.rule === "flaky one" ? { ...f, category: "flaky-test" } : { ...f },
      ),
      quarantineReport: {
        keys: ["flaky.test.ts::flaky one"],
        reasons: ["quarantined: flaky.test.ts::flaky one"],
      },
    }));

    const rectifiedStories: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, ctx) => {
      rectifiedStories.push(ctx.storyId);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });

    // Snapshot real.test.ts as failing in US-001's gate — transition attribution
    // will then attribute the genuine failure to US-001.
    const storyMetrics = [
      { storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["real.test.ts"] },
      { storyId: "US-002", completedAt: "2026-01-01T00:01:00.000Z", failingTestFiles: [] },
    ];
    const options = {
      config: TEST_CONFIG,
      prd: makePrd(["US-001", "US-002"]) as unknown as DeferredRegressionOptions["prd"],
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics,
    } as unknown as DeferredRegressionOptions;

    const result = await runDeferredRegression(options);

    // Only one per-story fix cycle should fire — for the story attributed to real.test.ts.
    expect(rectifiedStories).toHaveLength(1);
    expect(rectifiedStories[0]).toBe(result.affectedStories[0]);
    expect(result.affectedStories).toEqual(["US-001"]);
    // Quarantine report still surfaces the flaky-test.
    expect(result.quarantineReport?.keys).toContain("flaky.test.ts::flaky one");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — shared run-scoped memo → relabel without probe invocation
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — shared quarantine memo (AC5)", () => {
  test("AC5 — a test key already in the shared memo is relabeled flaky-test without invoking probe", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "shared.test.ts", testName: "shared one", error: "boom", stackTrace: [] }],
    }));

    // Memo is pre-seeded by an earlier gate.
    const memo: QuarantineMemo = (() => {
      const m = new Map<string, true>();
      m.set("shared.test.ts::shared one", true);
      return {
        has: (key: string) => m.has(key),
        add: (key: string) => {
          m.set(key, true);
        },
      };
    })();

    // Triage stub uses the memo to short-circuit.
    _regressionDeps.triageFlakyFindings = mock(
      async (input: { findings: Finding[]; quarantineMemo?: QuarantineMemo }) => {
        const memo = input.quarantineMemo;
        const result = input.findings.map((f) => {
          const key = `${f.file ?? ""}::${f.rule ?? ""}`;
          if (memo?.has(key)) return { ...f, category: "flaky-test" as const };
          return { ...f };
        });
        return {
          findings: result,
          quarantineReport: {
            keys: ["shared.test.ts::shared one"],
            reasons: ["quarantined (memo): shared.test.ts::shared one"],
          },
        };
      },
    );

    let fixCycleCalls = 0;
    _regressionDeps.runFixCycle = mock(async () => {
      fixCycleCalls += 1;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });

    const result = await runDeferredRegression(
      makeOptions({ storyIds: ["US-001"], quarantineMemo: memo }),
    );

    // No attribution, no fix cycle.
    expect(result.affectedStories).toEqual([]);
    expect(fixCycleCalls).toBe(0);
    // Quarantine report reflects the memo hit.
    expect(result.quarantineReport?.keys).toContain("shared.test.ts::shared one");
  });

  test("AC5 — memo is passed through to the triage call", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "shared.test.ts", testName: "shared one", error: "boom", stackTrace: [] }],
    }));

    const memo: QuarantineMemo = {
      has: () => false,
      add: () => {},
    };

    let capturedMemo: QuarantineMemo | undefined;
    _regressionDeps.triageFlakyFindings = mock(
      async (input: { findings: Finding[]; quarantineMemo?: QuarantineMemo }) => {
        capturedMemo = input.quarantineMemo;
        return {
          findings: input.findings.map((f) => ({ ...f, category: "flaky-test" as const })),
          quarantineReport: { keys: [], reasons: [] },
        };
      },
    );
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    }));

    await runDeferredRegression(makeOptions({ storyIds: ["US-001"], quarantineMemo: memo }));

    expect(capturedMemo).toBe(memo);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — quarantine report is returned with keys and reasons
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — quarantine report (AC6)", () => {
  test("AC6 — result includes quarantineReport with keys and reasons when at least one test is quarantined", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [
        { file: "flaky.test.ts", testName: "flaky one", error: "boom", stackTrace: [] },
        { file: "real.test.ts", testName: "real one", error: "boom", stackTrace: [] },
      ],
    }));

    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => ({
      findings: input.findings.map((f) =>
        f.file === "flaky.test.ts" ? { ...f, category: "flaky-test" as const } : { ...f },
      ),
      quarantineReport: {
        keys: ["flaky.test.ts::flaky one"],
        reasons: ["quarantined: flaky.test.ts::flaky one — probe passed 2/3"],
      },
    }));

    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    }));

    const result = await runDeferredRegression(makeOptions({ storyIds: ["US-001"] }));

    expect(result.quarantineReport).toBeDefined();
    expect(result.quarantineReport?.keys).toEqual(["flaky.test.ts::flaky one"]);
    expect(result.quarantineReport?.reasons[0]).toContain("flaky.test.ts::flaky one");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Disabled flake detection — triage runs but short-circuits, attribution + fix cycles continue
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — flakeDetection.enabled === false", () => {
  function makeDisabledConfig(): ReturnType<typeof makeNaxConfig> {
    return makeNaxConfig({
      quality: {
        commands: { test: "bun test" },
        forceExit: false,
        detectOpenHandles: false,
        detectOpenHandlesRetries: 0,
        gracePeriodMs: 0,
        drainTimeoutMs: 0,
        shell: false,
        stripEnvVars: [],
      },
      execution: {
        regressionGate: { mode: "deferred", timeoutSeconds: 60, acceptOnTimeout: true },
        flakeDetection: { enabled: false, probeRuns: 1, maxProbesPerGate: 5, probeTimeoutSeconds: 5 },
      },
    });
  }

  test("disabled triage returns findings unchanged (no quarantine, fix cycles still run)", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "real.test.ts", testName: "real one", error: "boom", stackTrace: [] }],
    }));

    // Spy triage to confirm it is invoked but should be a no-op.
    let triageInvocations = 0;
    _regressionDeps.triageFlakyFindings = mock(async (input: { findings: Finding[] }) => {
      triageInvocations += 1;
      // Real triage short-circuit when disabled — pass findings through.
      return { findings: input.findings, quarantineReport: { keys: [], reasons: [] } };
    });

    const rectifiedStories: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, ctx) => {
      rectifiedStories.push(ctx.storyId);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });

    const storyMetrics = [
      { storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["real.test.ts"] },
    ];

    const result = await runDeferredRegression({
      config: makeDisabledConfig(),
      prd: makePrd(["US-001"]) as unknown as DeferredRegressionOptions["prd"],
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics,
    } as unknown as DeferredRegressionOptions);

    // Triage was still called, but produced no quarantine.
    expect(triageInvocations).toBe(1);
    expect(result.quarantineReport).toBeUndefined();
    // Attribution + fix cycles proceeded normally.
    expect(rectifiedStories).toEqual(["US-001"]);
  });
});
