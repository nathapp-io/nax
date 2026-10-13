/** nax#2491 P7: the gates say what happened in one line (compact when green, expanded when red). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeScriptedCallOp, makeStepContext } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { runStoryGates, runWorkflowSuiteGate } from "@/workflow/gates";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
  let clock = 0;
  _workflowDeps.now = () => {
    clock += 700;
    return clock;
  };
});
afterEach(() => {
  resetLogger();
  Object.assign(_workflowDeps, original);
});

const sc = () =>
  makeStepContext({ config: makeNaxConfig({ quality: { commands: { lint: "lint", typecheck: "tc" } } }) });
const gateLines = () =>
  logs.filter((e) => e.stage === "workflow" && (e.data as { step?: string })?.step === "gates").map((e) => e.message);

const GREEN = {
  "lint-check": { success: true, findings: [], durationMs: 1 },
  "typecheck-check": { success: true, findings: [], durationMs: 1 },
  "verify-scoped": { success: true, status: "passed", findings: [], durationMs: 1, passCount: 4, isFullSuite: false },
  "full-suite-gate": { success: true, passed: true, status: "passed", estimatedCostUsd: 0, findings: [] },
} as const;

function fake(over: Record<string, unknown> = {}): void {
  const byOp: Record<string, unknown> = { ...GREEN, ...over };
  _workflowDeps.callOp = makeScriptedCallOp((op) => byOp[op.name]);
}

describe("story gates log", () => {
  test("green: one line with each gate's state and time, and the scoped test count", async () => {
    fake();
    await runStoryGates(sc());
    expect(gateLines()).toEqual(["US-001 gates lint ✓ 700ms · typecheck ✓ 700ms · scoped tests ✓ 700ms (4 tests)"]);
  });

  test("a skipped gate is marked, not timed as a pass", async () => {
    fake({ "lint-check": { success: true, status: "skipped", findings: [], durationMs: 0 } });
    await runStoryGates(sc());
    expect(gateLines()[0]).toContain("lint ⊘ skipped");
  });

  test("red: the line is expanded per gate, with the failing gate's findings", async () => {
    fake({
      "typecheck-check": {
        success: false,
        findings: [{ source: "typecheck", severity: "error", category: "type", message: "TS2322 bad", file: "a.ts" }],
        durationMs: 5,
      },
    });
    await runStoryGates(sc());
    const out = gateLines();
    expect(out[0]).toBe("US-001 gates red (typecheck)");
    expect(out).toContain("US-001 gate lint ✓ 700ms");
    expect(out.find((l) => l.startsWith("US-001 gate typecheck ✗ 700ms"))).toContain("TS2322 bad");
    expect(out).toContain("US-001 gate scoped tests ✓ 700ms (4 tests)");
  });

  test("a gate that throws is red and says so", async () => {
    _workflowDeps.callOp = makeScriptedCallOp((op) => {
      if (op.name === "lint-check") throw new Error("spawn failed");
      return GREEN[op.name as keyof typeof GREEN];
    });
    await runStoryGates(sc());
    expect(gateLines()[0]).toBe("US-001 gates red (lint)");
  });
});

describe("suite gate log", () => {
  test("green: one line", async () => {
    fake();
    await runWorkflowSuiteGate(sc());
    expect(gateLines()).toEqual(["US-001 gates full suite ✓ 700ms"]);
  });
});
