import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeScriptedCallOp, makeStepContext } from "@test/helpers";
import type { Finding } from "@/findings";
import {
  type FullSuiteGateOutput,
  fullSuiteGateOp,
  type LintCheckOutput,
  lintCheckOp,
  type TypecheckCheckOutput,
  typecheckCheckOp,
  type VerifyScopedOutput,
  verifyScopedOp,
} from "@/operations";
import { MAX_GATE_FINDINGS, runStoryGates, runWorkflowSuiteGate } from "@/workflow/gates";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";
import type { GateState } from "@/workflow/types";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

function sc(commands: Record<string, string> = { lint: "lint", typecheck: "tc" }): StepContext {
  return makeStepContext({ config: makeNaxConfig({ quality: { commands } }) });
}

type Result = LintCheckOutput | TypecheckCheckOutput | VerifyScopedOutput | FullSuiteGateOutput;

/** Fakes callOp by op name; a function value is invoked (and may throw). */
function fake(byOp: Record<string, Result | (() => Result)>): void {
  _workflowDeps.callOp = makeScriptedCallOp((op) => {
    const v = byOp[op.name];
    if (v === undefined) throw new Error(`fake(): no result configured for op "${op.name}"`);
    return typeof v === "function" ? v() : v;
  });
}

function lintFinding(message: string, extra: Partial<Finding> = {}): Finding {
  return { source: "lint", severity: "error", category: "style", message, ...extra };
}

const green = {
  [lintCheckOp.name]: { success: true, findings: [], durationMs: 1 },
  [typecheckCheckOp.name]: { success: true, findings: [], durationMs: 1 },
  [verifyScopedOp.name]: {
    success: true,
    status: "passed",
    findings: [],
    durationMs: 1,
    passCount: 3,
    isFullSuite: false,
  },
} satisfies Record<string, Result>;

describe("runStoryGates", () => {
  test("all green", async () => {
    fake(green);
    const r = await runStoryGates(sc());
    expect(r).toEqual({ red: false, states: { lint: "green", typecheck: "green", scoped: "green" }, findings: [] });
  });

  test("ops reporting status skipped -> skipped states, both ops still called", async () => {
    const skipped: LintCheckOutput = { success: true, status: "skipped", findings: [], durationMs: 1 };
    fake({ ...green, [lintCheckOp.name]: skipped, [typecheckCheckOp.name]: skipped });
    const called: string[] = [];
    const inner = _workflowDeps.callOp;
    _workflowDeps.callOp = async (ctx, op, input) => {
      called.push(op.name);
      return inner(ctx, op, input);
    };
    const r = await runStoryGates(sc({}));
    expect(r.states).toEqual({ lint: "skipped", typecheck: "skipped", scoped: "green" });
    expect(r.red).toBe(false);
    expect(called).toEqual([lintCheckOp.name, typecheckCheckOp.name, verifyScopedOp.name]);
  });

  test("lint findings become important gate findings", async () => {
    fake({
      ...green,
      [lintCheckOp.name]: {
        success: false,
        findings: [lintFinding("no-var", { file: "a.ts", line: 3 })],
        durationMs: 1,
      },
    });
    const r = await runStoryGates(sc());
    expect(r.red).toBe(true);
    expect(r.findings).toEqual([
      { kind: "gate", gate: "lint", severity: "important", file: "a.ts", line: 3, issue: "no-var" },
    ]);
  });

  test("Review Focus 2: failure with no parsed findings, or a thrown gate, is still red", async () => {
    fake({
      ...green,
      [typecheckCheckOp.name]: { success: false, findings: [], durationMs: 1 },
      [verifyScopedOp.name]: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const r = await runStoryGates(sc());
    expect(r.red).toBe(true);
    expect(r.states).toMatchObject({ typecheck: "red", scoped: "red" });
    expect(r.findings.map((f) => f.issue)).toEqual([
      "typecheck gate failed with no parsed findings",
      "scoped gate errored: spawn ENOENT",
    ]);
  });

  test("findings are capped with a summary line", async () => {
    const many = Array.from({ length: 30 }, (_, i) => lintFinding(`m${i}`));
    fake({ ...green, [lintCheckOp.name]: { success: false, findings: many, durationMs: 1 } });
    const r = await runStoryGates(sc());
    expect(r.findings).toHaveLength(MAX_GATE_FINDINGS + 1);
    expect(r.findings.at(-1)?.issue).toBe("lint: 5 more findings not shown");
  });
});

describe("runWorkflowSuiteGate", () => {
  const cases: ReadonlyArray<readonly [FullSuiteGateOutput["status"], boolean, GateState]> = [
    ["passed", false, "green"],
    // acceptOnTimeout is a pipeline-mode allowance: in workflow a suite that never finished is red.
    ["passed-on-timeout", true, "red"],
    ["skipped", false, "skipped"],
    ["failed", true, "red"],
    ["execution-failed", true, "red"],
    ["timeout", true, "red"],
    ["inconclusive", true, "red"],
  ];
  test.each(cases)("status %s -> red=%s state=%s", async (status, red, state) => {
    fake({
      [fullSuiteGateOp.name]: {
        success: !red,
        passed: !red,
        status,
        estimatedCostUsd: 0,
        findings: [],
        rawOutput: "",
      },
    });
    const r = await runWorkflowSuiteGate(sc());
    expect(r.red).toBe(red);
    expect(r.states["full-suite"]).toBe(state);
    if (red) expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe("run abort inside a gate", () => {
  test("is rethrown, not turned into a red finding", async () => {
    const ac = new AbortController();
    fake({
      ...green,
      [lintCheckOp.name]: () => {
        ac.abort();
        throw new Error("aborted");
      },
    });
    const base = sc();
    await expect(runStoryGates(makeStepContext({ ...base, runSignal: ac.signal }))).rejects.toThrow("aborted");
  });

  test("a gate error without an abort stays a red finding", async () => {
    fake({
      ...green,
      [lintCheckOp.name]: () => {
        throw new Error("boom");
      },
    });
    const r = await runStoryGates(sc());
    expect(r.states.lint).toBe("red");
  });
});
