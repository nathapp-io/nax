/** A1: the finish phase builds the advisor only for enabled callers and hands it to the machine. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { ADVISOR_DEFAULTS } from "@/config";
import type { FinishContext, FinishMachineDeps, FinishPhaseContext } from "@/finish";
import { _finishPhaseDeps, runFinishPhase } from "@/finish";
import type { NaxRuntime } from "@/runtime";

const PROCEED: FinishContext = {
  base: "origin/main",
  specPath: "spec.md",
  acceptanceStatus: "disabled",
  groups: [],
  testFileRegex: [],
  commitsAhead: 3,
  route: "proceed",
};

const runtimes: NaxRuntime[] = [];
let saved: typeof _finishPhaseDeps;
let seen: FinishMachineDeps | undefined;
beforeEach(() => {
  saved = { ..._finishPhaseDeps };
  seen = undefined;
  _finishPhaseDeps.loadFinishContext = async () => PROCEED;
  _finishPhaseDeps.detectForge = async () => null;
  _finishPhaseDeps.runFinishMachine = async (_state, deps) => {
    seen = deps;
    return { feature: "f", status: "already-ready" };
  };
});
afterEach(async () => {
  Object.assign(_finishPhaseDeps, saved);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

function ctxWith(callers: Partial<typeof ADVISOR_DEFAULTS.callers>): FinishPhaseContext {
  const runtime = makeTestRuntime({
    config: makeNaxConfig({
      advisor: { ...ADVISOR_DEFAULTS, enabled: true, callers: { ...ADVISOR_DEFAULTS.callers, ...callers } },
    }),
  });
  runtimes.push(runtime);
  return {
    runtime,
    config: { finish: { enabled: true, notify: { mode: "off" } } },
    feature: "f",
    workdir: "/tmp/finish-advisor",
    branch: "feat/x",
    runId: "run-1",
    agentName: "claude",
    abortSignal: new AbortController().signal,
    storySummary: { completed: 1, failed: 0, paused: 0 },
    packageDirs: [undefined],
  };
}

describe("runFinishPhase — advisor wiring (A1)", () => {
  test("no finish caller enabled → the machine gets no advisor", async () => {
    await runFinishPhase(ctxWith({}));
    expect(seen?.advise).toBeUndefined();
  });

  test("judgment only → judged on, approval off", async () => {
    await runFinishPhase(ctxWith({ finishJudgment: true }));
    expect(seen?.advise?.judgedEnabled).toBe(true);
    expect(seen?.advise?.approvalEnabled).toBe(false);
  });

  test("approval only → approval on, judged off", async () => {
    await runFinishPhase(ctxWith({ finishApproval: true }));
    expect(seen?.advise?.judgedEnabled).toBe(false);
    expect(seen?.advise?.approvalEnabled).toBe(true);
  });
});
