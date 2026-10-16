import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestPRD,
  makeTestStory,
} from "@test/helpers";
import { featureDir } from "@/config";
import { _runnerDeps, run } from "@/execution/runner";
import type { RunnerCompletionResult } from "@/execution/runner-completion";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  fullSuiteGateOp,
  lintCheckOp,
  typecheckCheckOp,
  verifyScopedOp,
  workflowBranchReviewOp,
  workflowImplementOp,
  workflowStoryReviewOp,
} from "@/operations";
import { _featureDeps } from "@/workflow/feature-deps";
import { workflowRunDir } from "@/workflow/paths";
import { readResult } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { runner: { ..._runnerDeps }, workflow: { ..._workflowDeps }, feature: { ..._featureDeps } };
const dirs: string[] = [];
afterEach(async () => {
  resetLogger();
  Object.assign(_runnerDeps, saved.runner);
  Object.assign(_workflowDeps, saved.workflow);
  Object.assign(_featureDeps, saved.feature);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

test("AC-17/18/19: runner defaults to workflow, completes its story and passes the end phase", async () => {
  const repo = makeTempDir("workflow-runner-");
  const out = makeTempDir("workflow-runner-out-");
  dirs.push(repo, out);
  await git(repo, "init", "-q", "-b", "feat/workflow");
  await git(repo, "config", "user.email", "test@example.test");
  await git(repo, "config", "user.name", "Test");
  await Bun.write(join(repo, "seed.ts"), "export const seed = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "seed");
  expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("1");

  const config = makeNaxConfig({
    outputDir: out,
    workflow: { publish: "none", preflight: false },
    acceptance: { enabled: false },
    execution: { iterationDelayMs: 0, regressionGate: { mode: "disabled" } },
    quality: { commands: {} },
  });
  // Exercise a direct caller before schema defaults populate this required runtime field.
  Reflect.deleteProperty(config.execution, "mode");
  expect(config.execution.mode).toBeUndefined();
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "pending", passes: false })]);
  const fd = featureDir(repo, prd.feature);
  const prdPath = join(fd, "prd.json");
  await Bun.write(prdPath, JSON.stringify(prd));
  const seen: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp(async (op) => {
    seen.push(op.name);
    if (op.name === workflowImplementOp.name)
      return { status: "DONE", commits: [], testSummary: "scripted pass", interrupted: false };
    if (op.name === workflowStoryReviewOp.name || op.name === workflowBranchReviewOp.name)
      return { spec: "pass", quality: "approved", findings: [], cannotVerify: [], inspectedFiles: [], minorTriage: [] };
    if (op.name === lintCheckOp.name || op.name === typecheckCheckOp.name)
      return { success: true, status: "skipped", findings: [], durationMs: 0 };
    if (op.name === verifyScopedOp.name)
      return { success: true, status: "passed", findings: [], durationMs: 0, passCount: 1, isFullSuite: false };
    if (op.name === fullSuiteGateOp.name)
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, findings: [], rawOutput: "" };
    throw new Error(`unexpected op ${op.name}`);
  });
  _featureDeps.resolveGateCommands = async () => [];
  _featureDeps.runQualityGates = async () => ({ passed: true, ran: ["test"], failing: [], output: "scripted pass" });
  const logs: LogEntry[] = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
  let end: RunnerCompletionResult | undefined;
  let runtimeRunId = "";
  _runnerDeps.runCompletionPhase = async (options) => {
    runtimeRunId = options.runtime.runId;
    end = await saved.runner.runCompletionPhase(options);
    return end;
  };
  const result = await run({
    config,
    prdPath,
    feature: prd.feature,
    featureDir: fd,
    workdir: repo,
    hooks: { hooks: {}, _skipGlobal: true },
    dryRun: false,
    skipPrecheck: true,
    statusFile: join(fd, "status.json"),
    formatterMode: "quiet",
  });
  expect(logs.filter((e) => e.level === "error")).toEqual([]);
  expect(result).toMatchObject({ success: true, storiesCompleted: 1 });
  expect(seen).toContain(workflowImplementOp.name);
  expect((await readResult(workflowRunDir(repo, prd.feature, runtimeRunId)))?.stories["US-001"]?.state).toBe(
    "complete",
  );
  expect(end?.workflowPassed).toBe(true);
  expect(result.success).toBe(true);
}, 30_000);
