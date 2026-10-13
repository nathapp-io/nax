import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeMockRuntime } from "@test/helpers";
import { _workflowEndReportDeps, reportWorkflowRun } from "@/execution/workflow-end-report";
import type { WorkflowSummaryView } from "@/log-format";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const original = { ..._workflowEndReportDeps };
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
afterEach(() => {
  resetLogger();
  Object.assign(_workflowEndReportDeps, original);
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
});
