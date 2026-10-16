import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { formatRunSummary } from "@/log-format/summary";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { _gitDeps } from "@/utils/git";

const MESSAGE = "Login for openai-codex was rejected. Run: nax auth login openai-codex";
const NOTICE = { providerId: "openai-codex", agent: "native", message: MESSAGE };
const original = { ..._runnerCompletionDeps };
const originalReport = { ..._workflowEndReportDeps };
const originalGit = _gitDeps.spawn;
const runtimes: ReturnType<typeof makeMockRuntime>[] = [];
let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
  _runnerCompletionDeps.handleRunCompletion = async () => ({
    durationMs: 100,
    runCompletedAt: new Date().toISOString(),
    reportedTotal: 0,
    pluginGateFailed: false,
    finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  });
  _runnerCompletionDeps.runFinishPhase = async () => null;
  _workflowEndReportDeps.readSummary = async () => null;
  _workflowEndReportDeps.saveDuration = async () => true;
  _gitDeps.spawn = makeSpawn().spawn;
});
afterEach(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  runtimes.length = 0;
  Object.assign(_runnerCompletionDeps, original);
  Object.assign(_workflowEndReportDeps, originalReport);
  _gitDeps.spawn = originalGit;
  resetLogger();
  pipelineEventBus.clear();
  mock.restore();
});
function options(): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  runtimes.push(runtime);
  return {
    config: makeNaxConfig({
      acceptance: { enabled: false },
      execution: { mode: "pipeline", regressionGate: { mode: "disabled" } },
    }),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "f",
    workdir: "/tmp/nax-test-auth-relogin",
    statusFile: "/tmp/nax-test-auth-relogin/status.json",
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    formatterMode: "normal",
    headless: true,
    prd: makePRD({ userStories: [makeStory({ status: "passed", passes: true })] }),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: makeStatusWriter(),
    pluginRegistry: makePluginRegistry(),
    prdPath: "/tmp/nax-test-auth-relogin/prd.json",
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  };
}
test.each(["normal", "json"] as const)("AC-20/21 completion reports notices after finish in %s mode", async (mode) => {
  const opts = options();
  opts.formatterMode = mode;
  const read = mock(() => [] as (typeof NOTICE)[]);
  opts.agentManager.authRelogins = read;
  _runnerCompletionDeps.runFinishPhase = async () => {
    read.mockImplementation(() => [NOTICE]);
    return null;
  };
  const output = spyOn(console, "log").mockImplementation(() => {});
  await runCompletionPhase(opts);
  expect(read).toHaveBeenCalledTimes(1);
  const warnings = logs.filter(
    (entry) => entry.level === "warn" && entry.stage === "execution" && entry.message === MESSAGE,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.data).toEqual({ storyId: "_run", providerId: "openai-codex" });
  if (mode === "normal")
    expect(output.mock.calls.flat().join("\n")).toMatch(/Re-login needed:[\s\S]*Login for openai-codex/);
  else expect(output.mock.calls.flat().join("\n")).not.toContain("Re-login needed:");
});
test("AC-22 empty notices omit footer block", async () => {
  const opts = options();
  opts.agentManager.authRelogins = () => [];
  const output = spyOn(console, "log").mockImplementation(() => {});
  await runCompletionPhase(opts);
  const text = output.mock.calls.flat().join("\n");
  expect(text).toContain("RUN SUMMARY");
  expect(text).not.toContain("Re-login needed:");
});
test("AC-23 summary prints hint after counts", () => {
  const output = formatRunSummary(
    {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      totalCost: 0,
      startedAt: "",
      completedAt: "",
      authRelogins: [MESSAGE],
    },
    { mode: "normal", useColor: false },
  );
  expect(output).toContain(`Re-login needed:\n    ${MESSAGE}`);
  expect(output.indexOf("Re-login needed:")).toBeGreaterThan(output.indexOf("Success:"));
});
