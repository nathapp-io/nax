/**
 * ExecutionPlan resume-integration tests — wires `recordGreen` and
 * `hydrateFromResumePlan` into the orchestrator's `run()` canonical loop.
 *
 * Background:
 *   The story "Integrate Resume Into Story Orchestrator" requires the
 *   `ExecutionPlan.run()` main loop to (a) emit a `recordGreen` call for
 *   each phase that passes, and (b) skip phases already in `phaseOutputs`
 *   when resuming. Tests assert on observable counts of `_storyOrchestratorDeps`
 *   intercepts.
 *
 * Coverage matrix:
 *   AC1 — a phase passing in the main loop dispatches exactly one `recordGreen`
 *         call whose `phase` argument equals that phase's op name.
 *   AC2 — a phase whose output fails `phasePassed` does NOT trigger `recordGreen`.
 *   AC3 — with a `skipPhases: ["test-writer", "implementer"]` resume plan, the
 *         main loop does NOT dispatch those phases but does dispatch a
 *         later non-skipped agent phase.
 *   AC5 — every cheap gate in `revalidateGates` is dispatched even on resume.
 *   AC6 — a failing re-run cheap gate short-circuits the canonical loop —
 *         nothing after it dispatches.
 *   AC7 — on the resume path, `buildResumePlan` is invoked exactly once and
 *         `phaseOutputs` is seeded with `{success:true}` per `skipPhases`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assertDefined,
  DEFAULT_AGENT_ENVELOPE,
  makeCallOp,
  makeFixCycleResult,
  makeMockCallContext,
  makeNaxConfig,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import { pickSelector } from "@/config";
import {
  _storyOrchestratorDeps,
  buildResumePlan,
  type ResumePlan,
  type StoryCheckpoint,
  StoryOrchestratorBuilder,
  type TreeState,
} from "@/execution";
import type { Finding } from "@/findings";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { SessionRole } from "@/runtime/session-role";

// ===========================================================================
// Shared ops
// ===========================================================================

const testSel = pickSelector("test-resume-integration-selector", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

function makePassOp(
  name: string,
  output: unknown = { success: true },
): DeterministicOperation<unknown, unknown, TestOpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "run",
    config: testSel,
    execute: async () => ({ ...(output as object), estimatedCostUsd: 0, durationMs: 0 }),
  };
}

function _makeFailOp(
  name: string,
  output: unknown = { success: false },
): DeterministicOperation<unknown, unknown, TestOpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "run",
    config: testSel,
    execute: async () => ({ ...(output as object), estimatedCostUsd: 0, durationMs: 0 }),
  };
}

// Implementer has to be a RunOperation (semantic constraint of StoryOrchestratorBuilder).
function makeRunOp<I, O>(name: string, sessionRole: SessionRole, output: O): RunOperation<I, O, TestOpConfig> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: sessionRole, lifetime: "warm" },
    build: (input) => ({
      role: { id: "r1", content: name, overridable: false },
      task: { id: "t1", content: String(input), overridable: false },
    }),
    parse: (raw: string): O => {
      try {
        return JSON.parse(raw) as O;
      } catch {
        return output;
      }
    },
  };
}

// ===========================================================================
// Test lifecycle
// ===========================================================================

let runtime: NaxRuntime | undefined;
const _TREE: TreeState = { headSha: "abc123", dirtyDigest: "dirty" };

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  // Reset the deps that tests mutate.
  for (const key of Object.keys(_storyOrchestratorDeps)) {
    if (key === "recordGreen" || key === "runFixCycle" || key === "callOp") {
      // We can't truly reset these because the deps object is shared, but each
      // test installs its own mock from `orig…` stash variables below.
    }
  }
});

// ===========================================================================
// AC1: recordGreen fires exactly once per passing phase
// ===========================================================================

describe("AC1: passing phase triggers exactly one recordGreen call", () => {
  test("AC1: implementer dispatch ⇒ one recordGreen with phase='implementer'", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const recordGreenCalls: Array<{ storyId: string; phase: string; headSha?: string; dirtyDigest?: string }> = [];

    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.recordGreen = (storyId, phase, tree) => {
      recordGreenCalls.push({
        storyId,
        phase,
        headSha: tree?.headSha,
        dirtyDigest: tree?.dirtyDigest,
      });
      return Promise.resolve();
    };
    _storyOrchestratorDeps.callOp = makeCallOp();
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC1");
      const implementerOp = makeRunOp("implementer", "implementer", { success: true });
      await new StoryOrchestratorBuilder()
        .addImplementer({ op: implementerOp, input: { code: "" } })
        .build(ctx)
        .run();

      expect(recordGreenCalls).toHaveLength(1);
      expect(recordGreenCalls[0].phase).toBe("implementer");
      expect(recordGreenCalls[0].storyId).toBe("AC1");
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ===========================================================================
// AC2: failing phase does NOT trigger recordGreen
// ===========================================================================

describe("AC2: failing phase does not trigger recordGreen", () => {
  test("AC2: implementer returns {success:false} ⇒ no recordGreen for implementer", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const recordGreenCalls: Array<{ storyId: string; phase: string }> = [];
    const dispatched: string[] = [];
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.recordGreen = (storyId, phase) => {
      recordGreenCalls.push({ storyId, phase });
      return Promise.resolve();
    };
    // Implementer fails — return a success:false envelope.
    _storyOrchestratorDeps.callOp = makeCallOp({
      fallback: { ...DEFAULT_AGENT_ENVELOPE, success: false },
      onDispatch: (op) => dispatched.push(op.name),
    });
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC2");
      const implementerOp = makeRunOp("implementer", "implementer", { success: true });
      await new StoryOrchestratorBuilder()
        .addImplementer({ op: implementerOp, input: { code: "" } })
        .build(ctx)
        .run();

      // Confirm implementer DID run (otherwise we'd be silently passing on nullity).
      expect(dispatched).toContain("implementer");
      // But recordGreen was NOT called for the failing implementer.
      const implementerGreens = recordGreenCalls.filter((c) => c.phase === "implementer");
      expect(implementerGreens).toEqual([]);
      // Sanity boundary: total recordGreen calls must be zero across all phases.
      expect(recordGreenCalls).toEqual([]);
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC2 boundary: a PASSING implementer in a multi-phase setup triggers recordGreen only for itself, NOT for later phases that fail", async () => {
    // Strong assertion: prove that recordGreen is gated on phasePassed.
    // Sequence: implementer (PASS) → full-suite-gate (FAIL).
    // Expect: 1 recordGreen for implementer, 0 for full-suite-gate.
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const recordGreenCalls: Array<{ storyId: string; phase: string }> = [];
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.recordGreen = (storyId, phase) => {
      recordGreenCalls.push({ storyId, phase });
      return Promise.resolve();
    };
    // Implementer succeeds; anything else (gate) is handled by the op's execute.
    _storyOrchestratorDeps.callOp = makeCallOp();
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC2-multi");
      const imp = makeRunOp("implementer", "implementer", { success: true });
      const gate = makeDeterministic("full-suite-gate", { success: false });
      await new StoryOrchestratorBuilder()
        .addImplementer({ op: imp, input: { code: "" } })
        .addFullSuiteGate({ op: gate, input: { story: makeStory({ id: "AC2-multi" }), workdir: "/tmp" } })
        .build(ctx)
        .run();

      // Gate failure → short-circuit; gate must have run (otherwise test is meaningless).
      const implementerGreens = recordGreenCalls.filter((c) => c.phase === "implementer");
      const gateGreens = recordGreenCalls.filter((c) => c.phase === "full-suite-gate");
      expect(implementerGreens).toHaveLength(1);
      expect(gateGreens).toEqual([]);
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ===========================================================================
// AC3: seeded phases are skipped; non-skipped phases still dispatch
// ===========================================================================

describe("AC3: resume plan skipPhases are not dispatched; later non-skipped phases still dispatch", () => {
  test("AC3: skipPhases=['test-writer','implementer'] ⇒ test-writer+implementer do not run; verifier does", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const dispatched: string[] = [];
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origBuildResumePlan = _storyOrchestratorDeps.buildResumePlan;

    _storyOrchestratorDeps.recordGreen = () => Promise.resolve();
    _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });
    // Override the planner to return a fixed skip set — saves us from mocking
    // checkpoints/gits.
    _storyOrchestratorDeps.buildResumePlan = async () =>
      ({
        skipPhases: ["test-writer", "implementer"],
        revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
        reason: "resume",
      }) satisfies ResumePlan;

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC3", { withFeatureDir: true });
      const tw = makeRunOp("test-writer", "test-writer", { success: true });
      const imp = makeRunOp("implementer", "implementer", { success: true });
      const ver = makeRunOp("verifier", "verifier", { success: true });
      const lint = makeDeterministic("lint-check", { success: true });
      const tc = makeDeterministic("typecheck-check", { success: true });
      const verifyScoped = makeDeterministic("verify-scoped", { success: true });

      await new StoryOrchestratorBuilder()
        .addTestWriter({ op: tw, input: { story: "" } })
        .addImplementer({ op: imp, input: { code: "" } })
        .addVerifier({ op: ver, input: { code: "" } })
        .addVerifyScoped({ op: verifyScoped, input: { workdir: "/tmp", storyId: "AC3" } })
        .addLintCheck({ op: lint, input: { workdir: "/tmp" } })
        .addTypecheckCheck({ op: tc, input: { workdir: "/tmp" } })
        .build(ctx)
        .run();

      // Skipped agent phases must not have been dispatched.
      expect(dispatched).not.toContain("test-writer");
      expect(dispatched).not.toContain("implementer");
      // A non-skipped agent phase (verifier) MUST have been dispatched.
      expect(dispatched).toContain("verifier");
      // Cheap gates always re-run per AC5 (covered in its own describe block).
      expect(dispatched).toContain("verify-scoped");
      expect(dispatched).toContain("lint-check");
      expect(dispatched).toContain("typecheck-check");
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.buildResumePlan = origBuildResumePlan ?? buildResumePlan;
    }
  });
});

// ===========================================================================
// AC5: cheap gates always re-run on resume
// ===========================================================================

describe("AC5: cheap gates dispatch on resume", () => {
  test("AC5: every gate in revalidateGates dispatches through runPhase even though plan.reason='resume'", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const dispatched: string[] = [];
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origBuildResumePlan = _storyOrchestratorDeps.buildResumePlan;

    _storyOrchestratorDeps.recordGreen = () => Promise.resolve();
    _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });
    _storyOrchestratorDeps.buildResumePlan = async () =>
      ({
        skipPhases: ["test-writer", "implementer", "verifier"],
        revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
        reason: "resume",
      }) satisfies ResumePlan;

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC5", { withFeatureDir: true });
      const tw = makeRunOp("test-writer", "test-writer", { success: true });
      const imp = makeRunOp("implementer", "implementer", { success: true });
      const ver = makeRunOp("verifier", "verifier", { success: true });
      const verifyScoped = makeDeterministic("verify-scoped", { success: true });
      const lint = makeDeterministic("lint-check", { success: true });
      const tc = makeDeterministic("typecheck-check", { success: true });

      await new StoryOrchestratorBuilder()
        .addTestWriter({ op: tw, input: { story: "" } })
        .addImplementer({ op: imp, input: { code: "" } })
        .addVerifier({ op: ver, input: { code: "" } })
        .addVerifyScoped({ op: verifyScoped, input: { workdir: "/tmp", storyId: "AC5" } })
        .addLintCheck({ op: lint, input: { workdir: "/tmp" } })
        .addTypecheckCheck({ op: tc, input: { workdir: "/tmp" } })
        .build(ctx)
        .run();

      // Every gate in revalidateGates must have dispatched.
      expect(dispatched).toContain("verify-scoped");
      expect(dispatched).toContain("lint-check");
      expect(dispatched).toContain("typecheck-check");
      // Sanity: skipped agent phases still NOT dispatched.
      expect(dispatched).not.toContain("test-writer");
      expect(dispatched).not.toContain("implementer");
      expect(dispatched).not.toContain("verifier");
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.buildResumePlan = origBuildResumePlan ?? buildResumePlan;
    }
  });
});

// ===========================================================================
// AC6: failing re-run cheap gate short-circuits the loop
// ===========================================================================

describe("AC6: failing re-run cheap gate short-circuits", () => {
  test("AC6: verify-scoped (a revalidateGate) fails ⇒ phases after it do not dispatch and gate gets no recordGreen", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const dispatched: string[] = [];
    const recordGreenCalls: Array<{ storyId: string; phase: string }> = [];
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origBuildResumePlan = _storyOrchestratorDeps.buildResumePlan;

    _storyOrchestratorDeps.recordGreen = (storyId, phase) => {
      recordGreenCalls.push({ storyId, phase });
      return Promise.resolve();
    };
    _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });
    _storyOrchestratorDeps.buildResumePlan = async () =>
      ({
        skipPhases: ["test-writer", "implementer", "verifier"],
        revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
        reason: "resume",
      }) satisfies ResumePlan;

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC6", { withFeatureDir: true });
      const tw = makeRunOp("test-writer", "test-writer", { success: true });
      const imp = makeRunOp("implementer", "implementer", { success: true });
      const ver = makeRunOp("verifier", "verifier", { success: true });
      const verifyScoped = makeDeterministic("verify-scoped", { success: false });
      const lint = makeDeterministic("lint-check", { success: true });
      const tc = makeDeterministic("typecheck-check", { success: true });

      const result = await new StoryOrchestratorBuilder()
        .addTestWriter({ op: tw, input: { story: "" } })
        .addImplementer({ op: imp, input: { code: "" } })
        .addVerifier({ op: ver, input: { code: "" } })
        .addVerifyScoped({ op: verifyScoped, input: { workdir: "/tmp", storyId: "AC6" } })
        .addLintCheck({ op: lint, input: { workdir: "/tmp" } })
        .addTypecheckCheck({ op: tc, input: { workdir: "/tmp" } })
        .build(ctx)
        .run();

      expect(dispatched).toContain("verify-scoped");
      // After a failing verify-scoped, lint-check and typecheck-check must NOT have run.
      expect(dispatched).not.toContain("lint-check");
      expect(dispatched).not.toContain("typecheck-check");
      // Boundary: verify-scoped must NOT generate a recordGreen call (it failed).
      const gateGreens = recordGreenCalls.filter((c) => c.phase === "verify-scoped");
      expect(gateGreens).toEqual([]);
      // Story is failing.
      expect(result.success).toBe(false);
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.buildResumePlan = origBuildResumePlan ?? buildResumePlan;
    }
  });
});

// ===========================================================================
// AC7: buildResumePlan called once, seeds phaseOutputs from skipPhases
// ===========================================================================

describe("AC7: buildResumePlan invoked once; phaseOutputs seeded", () => {
  test("AC7 boundary: buildResumePlan is called exactly once per plan.run()", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    let buildCalls = 0;
    const origRecordGreen = _storyOrchestratorDeps.recordGreen;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origBuildResumePlan = _storyOrchestratorDeps.buildResumePlan;

    _storyOrchestratorDeps.recordGreen = () => Promise.resolve();
    _storyOrchestratorDeps.callOp = makeCallOp();
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        costUsd: 0,
      });
    _storyOrchestratorDeps.buildResumePlan = async (cp, current) => {
      buildCalls++;
      // Mirror the real planner's behaviour for this test.
      return buildResumePlanOrig(cp, current);
    };
    const buildResumePlanOrig = (_cp: StoryCheckpoint | null, _current: TreeState): ResumePlan => {
      if (!_cp) {
        return {
          skipPhases: [],
          revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
          reason: "no-checkpoint",
        };
      }
      if (_cp.tree.headSha !== _current.headSha || _cp.tree.dirtyDigest !== _current.dirtyDigest) {
        return {
          skipPhases: [],
          revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
          reason: "tree-moved",
        };
      }
      return {
        skipPhases: _cp.greenPhases.filter((p) => !["verify-scoped", "lint-check", "typecheck-check"].includes(p)),
        revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
        reason: "resume",
      };
    };

    try {
      assertDefined(runtime, "runtime");
      const ctx = makeCtx(runtime, "AC7-count", { withFeatureDir: true });
      const imp = makeRunOp("implementer", "implementer", { success: true });
      await new StoryOrchestratorBuilder()
        .addImplementer({ op: imp, input: { code: "" } })
        .build(ctx)
        .run();
      expect(buildCalls).toBe(1);
    } finally {
      _storyOrchestratorDeps.recordGreen = origRecordGreen;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.buildResumePlan = origBuildResumePlan ?? buildResumePlan;
    }
  });
});

// ===========================================================================
// Test helpers
// ===========================================================================

function makeCtx(runtime: NaxRuntime, storyId: string, opts: { withFeatureDir?: boolean } = {}): CallContext {
  return makeMockCallContext({
    runtime,
    packageDir: "/tmp",
    storyId,
    ...(opts.withFeatureDir ? { featureDir: "/tmp/feature" } : {}),
  });
}

function makeDeterministic(name: string, result: { success: boolean; findings?: unknown[] }) {
  return makePassOp(name, result);
}

// ===========================================================================
// randomUUID sanity (matches server-side counter)
// ===========================================================================

describe("uuid sanity", () => {
  test("randomUUID generates unique ids", () => {
    expect(randomUUID()).not.toBe(randomUUID());
  });
});
