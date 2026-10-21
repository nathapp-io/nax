import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeMockRuntime, makeTempDir } from "@test/helpers";
import { _workflowEndReportDeps, reportWorkflowRun } from "@/execution/workflow-end-report";
import type { WorkflowSummaryView } from "@/log-format";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { newFeatureRecord } from "@/workflow/feature-record";
import { workflowRunDir } from "@/workflow/paths";
import { upsertFeatureRecord } from "@/workflow/result";

const original = { ..._workflowEndReportDeps };
const dirs: string[] = [];
const opts = { workdir: "/repo", feature: "f", runId: "r1", runtime: makeMockRuntime() };
const timing = { storiesDurationMs: 8_393_000, featureWorkflowDurationMs: 1_055_000 };
const view: WorkflowSummaryView = {
  ...timing,
  roles: [],
  stories: [],
  branch: { found: 4, fixed: 3, left: 1, minorsLeft: 0 },
  publish: { outcome: "local-only", reasons: [] },
};

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(async () => {
  resetLogger();
  Object.assign(_workflowEndReportDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

describe("reportWorkflowRun", () => {
  test("logs one summary line with the split and returns the view", async () => {
    _workflowEndReportDeps.readSummary = async () => view;
    expect(await reportWorkflowRun(opts, timing)).toEqual(view);
    const line = logs.find((e) => e.message.startsWith("Workflow summary:"));
    expect(line?.message).toBe(
      "Workflow summary: stories 139m 53s + feature workflow 17m 35s; branch findings 4 found, 3 fixed, 1 left; publish local-only",
    );
    expect(Object.keys(line?.data ?? {})[0]).toBe("storyId");
  });

  test("the line names the branch fix rounds and any gate repair (nax#2547, nax#2548)", async () => {
    _workflowEndReportDeps.readSummary = async () => ({
      ...view,
      branch: { found: 4, fixed: 3, left: 1, minorsLeft: 1, fixRounds: 2 },
      gateRepairRounds: 1,
    });
    await reportWorkflowRun(opts, timing);
    const line = logs.find((e) => e.message.startsWith("Workflow summary:"));
    expect(line?.message).toContain(
      "branch findings 4 found, 3 fixed, 1 left over 2 fix rounds; gate repair rounds 1;",
    );
  });

  // US-008: a CI repair is a repair like any other, and its rounds are named at run end.
  test("AC-14: the line names the CI repair rounds", async () => {
    _workflowEndReportDeps.readSummary = async () => ({ ...view, ciRepairRounds: 2 });
    await reportWorkflowRun(opts, timing);
    const line = logs.find((e) => e.message.startsWith("Workflow summary:"));
    expect(line?.message).toContain("CI repair rounds 2");
  });

  test("no result.json: nothing logged, nothing returned", async () => {
    _workflowEndReportDeps.readSummary = async () => null;
    expect(await reportWorkflowRun(opts, timing)).toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  test("a read failure is a warning, never a throw", async () => {
    _workflowEndReportDeps.readSummary = async () => {
      throw new Error("disk gone");
    };
    expect(await reportWorkflowRun(opts, timing)).toBeUndefined();
    expect(logs.map((e) => [e.level, e.message])).toEqual([["warn", "Workflow summary unavailable"]]);
  });

  test("a feature record with flagged rulings names the count and the feature hint (US-005)", async () => {
    const dir = makeTempDir("wf-end-report-");
    dirs.push(dir);
    const runtime = makeMockRuntime();
    const runDir = workflowRunDir(dir, "f", runtime.runId);
    await upsertFeatureRecord(
      runDir,
      { runId: runtime.runId, feature: "f" },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "done",
        outcome: "local-only",
        reasons: [],
        passed: true,
        flaggedDecisions: ["D-1"],
      },
    );
    const view = await reportWorkflowRun({ workdir: dir, feature: "f", runId: runtime.runId, runtime }, timing);
    expect(view?.flagged).toEqual({ ids: ["D-1"], hint: "nax advisor list -f f" });
    const line = logs.find((e) => e.message.startsWith("Workflow summary:"));
    expect(line?.message).toContain("flagged 1 (nax advisor list -f f)");
  });
});
