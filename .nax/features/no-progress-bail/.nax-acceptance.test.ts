import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema, pickSelector } from "../../../src/config";
import {
  StoryOrchestratorBuilder,
  _storyOrchestratorDeps,
  buildRectificationPhaseOptions,
  withIncreasingFailuresBail,
  withNoProgressBail,
} from "../../../src/execution";
import type { Finding, FixStrategy, Iteration } from "../../../src/findings";
import type { CallContext, DeterministicOperation, RunOperation } from "../../../src/operations";
import type { NaxRuntime } from "../../../src/runtime";
import { makeStory, makeTestRuntime } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — Config fields (AC-1..AC-6) and buildRectificationPhaseOptions (AC-7..AC-9)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: NaxConfigSchema.parse({}) defaults abortOnNoProgress to true", () => {
  test("AC-1: execution.rectification.abortOnNoProgress === true", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.execution.rectification.abortOnNoProgress).toBe(true);
  });
});

describe("AC-2: NaxConfigSchema.parse({}) defaults consecutiveNoProgressToBail to 3", () => {
  test("AC-2: execution.rectification.consecutiveNoProgressToBail === 3", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.execution.rectification.consecutiveNoProgressToBail).toBe(3);
  });
});

describe("AC-3: consecutiveNoProgressToBail === 0 fails validation", () => {
  test("AC-3: NaxConfigSchema.parse throws for consecutiveNoProgressToBail: 0", () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { rectification: { consecutiveNoProgressToBail: 0 } } }),
    ).toThrow();
  });
});

describe("AC-4: consecutiveNoProgressToBail === 11 fails validation", () => {
  test("AC-4: NaxConfigSchema.parse throws for consecutiveNoProgressToBail: 11", () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { rectification: { consecutiveNoProgressToBail: 11 } } }),
    ).toThrow();
  });
});

describe("AC-5: consecutiveNoProgressToBail === 1 parses successfully", () => {
  test("AC-5: NaxConfigSchema.parse does not throw for consecutiveNoProgressToBail: 1", () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { rectification: { consecutiveNoProgressToBail: 1 } } }),
    ).not.toThrow();
  });
});

describe("AC-6: consecutiveNoProgressToBail === 10 parses successfully", () => {
  test("AC-6: NaxConfigSchema.parse does not throw for consecutiveNoProgressToBail: 10", () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { rectification: { consecutiveNoProgressToBail: 10 } } }),
    ).not.toThrow();
  });
});

describe("AC-7: buildRectificationPhaseOptions carries abortOnNoProgress from config", () => {
  test("AC-7: options.abortOnNoProgress === false when config sets it false", () => {
    const config = {
      execution: { rectification: { enabled: true, abortOnNoProgress: false, consecutiveNoProgressToBail: 7 } },
    };
    const options = buildRectificationPhaseOptions(NaxConfigSchema.parse(config));
    expect(options.abortOnNoProgress).toBe(false);
  });
});

describe("AC-8: buildRectificationPhaseOptions carries consecutiveNoProgressToBail from config", () => {
  test("AC-8: options.consecutiveNoProgressToBail === 7 when config sets it 7", () => {
    const config = {
      execution: { rectification: { enabled: true, abortOnNoProgress: false, consecutiveNoProgressToBail: 7 } },
    };
    const options = buildRectificationPhaseOptions(NaxConfigSchema.parse(config));
    expect(options.consecutiveNoProgressToBail).toBe(7);
  });
});

describe("AC-9: explicit abortOnNoProgress: false overrides the schema default", () => {
  test("AC-9: NaxConfigSchema.parse({execution:{rectification:{abortOnNoProgress:false}}}) yields false", () => {
    const result = NaxConfigSchema.parse({ execution: { rectification: { abortOnNoProgress: false } } });
    expect(result.execution.rectification.abortOnNoProgress).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — withNoProgressBail unit behaviour (AC-10..AC-20, AC-24)
// ─────────────────────────────────────────────────────────────────────────────

function npFinding(id: string, source: Finding["source"] = "test-runner"): Finding {
  return { severity: "error", category: "test", source, message: `finding-${id}` };
}

function npIter(num: number, before: Finding[], after: Finding[]): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: before,
    findingsAfter: after,
    fixesApplied: [{ strategyName: "s", op: "noop-op", targetFiles: [], summary: "" }],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

function npBaseStrategy(): FixStrategy<Finding, unknown, unknown, unknown> {
  return {
    name: "no-progress-test-strategy",
    appliesTo: () => true,
    fixOp: { name: "noop" } as unknown as FixStrategy<Finding, unknown, unknown, unknown>["fixOp"],
    buildInput: () => ({}),
    maxAttempts: 20,
    coRun: "exclusive",
  };
}

function npBailOf(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
): (iters: Iteration<Finding>[]) => string | null {
  const fn = strategies[0]?.bailWhen;
  if (!fn) throw new Error("expected bailWhen to be wrapped");
  return fn;
}

describe("AC-10: three trailing iterations with the same unresolved finding bail", () => {
  test("AC-10: identical single finding in findingsBefore/findingsAfter for 3 iterations returns a non-null reason", () => {
    const f = npFinding("A");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const iterations = [npIter(1, [f], [f]), npIter(2, [f], [f]), npIter(3, [f], [f])];
    expect(bail(iterations)).not.toBeNull();
  });
});

describe("AC-11: an iteration that resolves a finding each time never bails", () => {
  test("AC-11: five iterations that each remove a different finding from a five-finding set returns null", () => {
    const findings = ["A", "B", "C", "D", "E"].map((id) => npFinding(id));
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const iterations = findings.map((removed, i) =>
      npIter(
        i + 1,
        findings,
        findings.filter((f) => f !== removed),
      ),
    );
    expect(bail(iterations)).toBeNull();
  });
});

describe("AC-12: two no-progress iterations at threshold 3 do not bail", () => {
  test("AC-12: exactly two no-progress iterations returns null", () => {
    const f = npFinding("A");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    expect(bail([npIter(1, [f], [f]), npIter(2, [f], [f])])).toBeNull();
  });
});

describe("AC-13: a third consecutive no-progress iteration bails at threshold 3", () => {
  test("AC-13: appending a third no-progress iteration returns a non-null reason", () => {
    const f = npFinding("A");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    expect(bail([npIter(1, [f], [f]), npIter(2, [f], [f]), npIter(3, [f], [f])])).not.toBeNull();
  });
});

describe("AC-14: persisting findings plus new findings still counts as no progress", () => {
  test("AC-14: before-keys all survive into after (which also grows) returns a non-null reason", () => {
    const f1 = npFinding("A");
    const f2 = npFinding("B");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const iterations = [1, 2, 3].map((n) =>
      npIter(n, [f1, f2], [f1, f2, npFinding(`new-${n}-1`), npFinding(`new-${n}-2`)]),
    );
    expect(bail(iterations)).not.toBeNull();
  });
});

describe("AC-15: disabled withNoProgressBail returns the same strategy objects", () => {
  test("AC-15: enabled=false returns strategy entries === the objects passed in", () => {
    const original = npBaseStrategy();
    const [wrapped] = withNoProgressBail([original], false, 3);
    expect(wrapped).toBe(original);
  });
});

describe("AC-16: disabled withNoProgressBail leaves bailWhen unchanged", () => {
  test("AC-16: enabled=false returns a strategy whose bailWhen is unchanged (still undefined)", () => {
    const original = npBaseStrategy();
    const [wrapped] = withNoProgressBail([original], false, 3);
    expect(wrapped.bailWhen).toBe(original.bailWhen);
    expect(wrapped.bailWhen).toBeUndefined();
  });
});

describe("AC-17: a user-supplied bailWhen wins over the no-progress predicate", () => {
  test("AC-17: input strategy's bailWhen returning 'user-stop' wins for three no-progress iterations", () => {
    const f = npFinding("A");
    const strat = { ...npBaseStrategy(), bailWhen: () => "user-stop" };
    const bail = npBailOf(withNoProgressBail([strat], true, 3));
    expect(bail([npIter(1, [f], [f]), npIter(2, [f], [f]), npIter(3, [f], [f])])).toBe("user-stop");
  });
});

describe("AC-18: an empty findingsBefore is treated as progress, not a stall", () => {
  test("AC-18: three trailing iterations with empty findingsBefore return null", () => {
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const iterations = [npIter(1, [], []), npIter(2, [], []), npIter(3, [], [])];
    expect(bail(iterations)).toBeNull();
  });
});

describe("AC-19: the bail reason reports the iteration count", () => {
  test("AC-19: three no-progress iterations with two persisting findings — reason includes '3'", () => {
    const f1 = npFinding("A");
    const f2 = npFinding("B");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const reason = bail([
      npIter(1, [f1, f2], [f1, f2]),
      npIter(2, [f1, f2], [f1, f2]),
      npIter(3, [f1, f2], [f1, f2]),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain("3");
  });
});

describe("AC-20: the bail reason reports the persisting-finding count", () => {
  test("AC-20: three no-progress iterations with two persisting findings — reason includes '2'", () => {
    const f1 = npFinding("A");
    const f2 = npFinding("B");
    const bail = npBailOf(withNoProgressBail([npBaseStrategy()], true, 3));
    const reason = bail([
      npIter(1, [f1, f2], [f1, f2]),
      npIter(2, [f1, f2], [f1, f2]),
      npIter(3, [f1, f2], [f1, f2]),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain("2");
  });
});

describe("AC-24: no-progress outranks the count-increase reason when both fire", () => {
  test("AC-24: withNoProgressBail composed with withIncreasingFailuresBail (both threshold 3) returns the no-progress reason", () => {
    // Both predicates check their delegate's bailWhen before falling back to their own
    // condition (mirroring withIncreasingFailuresBail's established "delegate wins"
    // composition, per AC-17 above). For the no-progress reason to win when both
    // conditions fire simultaneously, the no-progress predicate is composed as the
    // innermost wrapper so its own check resolves before the count-increase wrapper
    // ever needs to fall back to its own condition.
    const f = npFinding("A");
    const withNp = withNoProgressBail([npBaseStrategy()], true, 3);
    const combined = withIncreasingFailuresBail(withNp, true, 3);
    const bail = npBailOf(combined);

    // Each iteration is simultaneously no-progress (the single finding persists
    // unresolved) AND count-increasing (findingsAfter.length > findingsBefore.length
    // across the trailing window), by growing the persisting finding's iteration
    // one at a time relative to a single-finding baseline.
    const iterations = [
      npIter(1, [f], [f, npFinding("extra-1")]),
      npIter(2, [f], [f, npFinding("extra-2")]),
      npIter(3, [f], [f, npFinding("extra-3")]),
    ];

    const reason = bail(iterations);
    expect(reason).not.toBeNull();
    // withIncreasingFailuresBail's own reason always carries an arrow
    // ("<before> -> <after>"); the no-progress reason never does. Absence of
    // the arrow is a format-independent signal that the no-progress branch,
    // not the count-increase branch, produced this string.
    expect(reason).not.toContain("->");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — runRectification production entry point (AC-21..AC-23)
// ─────────────────────────────────────────────────────────────────────────────

const npTestSel = pickSelector("test-no-progress-bail-sel", "execution");

const NP_GATE_FINDING_1: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "no-progress gate finding 1",
  file: "test/foo.test.ts",
};

const NP_GATE_FINDING_2: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "no-progress gate finding 2",
  file: "test/bar.test.ts",
};

const npMockImplementerOp: RunOperation<{ code: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: npTestSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Implement", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function npMakeGateOp(): DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> {
  return {
    kind: "deterministic",
    name: "full-suite-gate",
    stage: "verify",
    config: npTestSel as never,
    execute: async () => ({
      success: false,
      findings: [NP_GATE_FINDING_1, NP_GATE_FINDING_2],
      normalizedFindings: [NP_GATE_FINDING_1, NP_GATE_FINDING_2],
      estimatedCostUsd: 0,
    }),
  };
}

const npFixDispatchOp: RunOperation<{ story: string }, { applied: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "no-progress-fixop",
  stage: "rectification",
  config: npTestSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r-fix", content: "Fix", overridable: false },
    task: { id: "t-fix", content: "Fix the findings", overridable: false },
  }),
  parse: () => ({ applied: true }),
};

function npFixStrategy(): FixStrategy<Finding, { story: string }, { applied: boolean }> {
  return {
    name: "no-progress-fix-strategy",
    appliesTo: (f) => f.source === "test-runner",
    fixOp: npFixDispatchOp,
    buildInput: () => ({ story: "US-np" }),
    maxAttempts: 20,
    coRun: "exclusive",
  };
}

let npOrigCallOp: typeof _storyOrchestratorDeps.callOp;
let npOrigRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let npOrigCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let npRuntime: NaxRuntime;

function npMakeCtx(storyId: string): CallContext {
  npRuntime = makeTestRuntime();
  return {
    runtime: npRuntime,
    packageView: npRuntime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  } as CallContext;
}

beforeEach(() => {
  npOrigCallOp = _storyOrchestratorDeps.callOp;
  npOrigRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  npOrigCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = npOrigCallOp;
  _storyOrchestratorDeps.runFixCycle = npOrigRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = npOrigCaptureGitRef;
  await npRuntime?.close();
});

/**
 * Drives the real (unmocked) `runFixCycle` path — `callOp` is mocked to always
 * report the same two findings from `full-suite-gate` no matter how many times
 * the rectification strategy's fix op runs, so the cycle never resolves and any
 * progress made is purely an artifact of the bail wiring under test.
 */
function npRunScenario(abortOnNoProgress: boolean, storyId: string) {
  const opCounts: Record<string, number> = {};
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    const name = op.name;
    opCounts[name] = (opCounts[name] ?? 0) + 1;
    if (name === "implementer") return { success: true };
    if (name === "full-suite-gate") {
      return {
        success: false,
        findings: [NP_GATE_FINDING_1, NP_GATE_FINDING_2],
        normalizedFindings: [NP_GATE_FINDING_1, NP_GATE_FINDING_2],
        estimatedCostUsd: 0,
      };
    }
    if (name === "no-progress-fixop") return { applied: true };
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;

  const ctx = npMakeCtx(storyId);
  const story = makeStory({ id: storyId });

  const runPromise = new StoryOrchestratorBuilder()
    .addImplementer({ op: npMockImplementerOp, input: { code: "" } })
    .addFullSuiteGate({ op: npMakeGateOp(), input: { story, workdir: "/tmp" } })
    .addRectification({
      maxAttempts: 12,
      strategies: [npFixStrategy()],
      abortOnIncreasingFailures: false,
      abortOnNoProgress,
      consecutiveNoProgressToBail: 3,
    } as never)
    .build(ctx)
    .run();

  return { runPromise, opCounts };
}

describe("AC-21: runRectification exhausts a stalled cycle at the no-progress threshold", () => {
  test("AC-21: rectificationExhausted is true when validation always returns the same two findings", async () => {
    const { runPromise } = npRunScenario(true, "US-np-21");
    const result = await runPromise;
    expect(result.rectificationExhausted).toBe(true);
  });
});

describe("AC-22: the no-progress bail stops fix-op dispatch at exactly the threshold", () => {
  test("AC-22: the rectification strategy's fix operation is dispatched exactly 3 times", async () => {
    const { runPromise, opCounts } = npRunScenario(true, "US-np-22");
    await runPromise;
    expect(opCounts["no-progress-fixop"] ?? 0).toBe(3);
  });
});

describe("AC-23: abortOnNoProgress: false lets a stalled cycle keep dispatching past the threshold", () => {
  test("AC-23: the rectification strategy's fix operation is dispatched more than 3 times", async () => {
    const { runPromise, opCounts } = npRunScenario(false, "US-np-23");
    await runPromise;
    expect(opCounts["no-progress-fixop"] ?? 0).toBeGreaterThan(3);
  });
});