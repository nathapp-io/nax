import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
} from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import { workflowBranchFixOp, workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import { runBranchFix } from "@/workflow/branch-fix";
import { runBranchReReview, runBranchReview } from "@/workflow/branch-review";
import type { BranchStepContext } from "@/workflow/branch-step-context";
import { _featureContextDeps, buildFeatureContext } from "@/workflow/feature-context";
import { _featureDeps } from "@/workflow/feature-deps";
import { runRepoGates } from "@/workflow/repo-gates";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict, ImplementerReply } from "@/workflow/types";

const original = { ..._workflowDeps };
const featureOriginal = { ..._featureDeps };
const contextOriginal = { ..._featureContextDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  Object.assign(_featureDeps, featureOriginal);
  Object.assign(_featureContextDeps, contextOriginal);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

function context(): BranchStepContext {
  const projectDir = makeTempDir("branch-no-prd-");
  dirs.push(projectDir);
  const runDir = join(projectDir, "review");
  const config = makeNaxConfig();
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return {
    callCtx: makeMockCallContext(),
    config,
    workflow: resolveWorkflowConfig(config),
    feature: "bot-pr-42",
    projectDir,
    runDir,
    reportPath: join(runDir, "feature-report.md"),
    packageDirs: [],
    dryRun: false,
  };
}
const facts = { stories: [], minors: [], parked: [], cannotVerify: [], gateFindings: [] };
const verdict: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};

describe("runBranchReview with a narrow context", () => {
  test("AC-7/8 sends the no-PRD prompt and writes the package in runDir", async () => {
    const ctx = context();
    const seen: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowBranchReviewOp);
      seen.push(input);
      return verdict;
    });
    expect(await runBranchReview(ctx, { seed: "base", facts })).toEqual({ ran: true, verdict });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: expect.stringContaining("(no PRD for this change)") });
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).text()).toContain("## Changed files (0)");
  });

  test("AC-9 still forwards the PRD from buildFeatureContext", async () => {
    const ctx = context();
    _featureContextDeps.buildRunDispatchAskWiring = async () => ({
      askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }) },
      commandShadow: undefined,
      dispose: async () => {},
    });
    const runtime = makeTestRuntime({ config: ctx.config, workdir: ctx.projectDir });
    runtimes.push(runtime);
    const { fc, dispose } = await buildFeatureContext({
      runtime,
      config: ctx.config,
      prd: makeTestPRD(),
      feature: "f",
      workdir: ctx.projectDir,
      branch: "feature",
      runId: runtime.runId,
      agentName: "claude",
    });
    const seen: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowBranchReviewOp);
      seen.push(input);
      return verdict;
    });
    try {
      expect((await runBranchReview(fc, { seed: "base", facts })).ran).toBe(true);
      expect(seen[0]).toMatchObject({
        prompt: expect.stringContaining(`- the PRD (stories and acceptance criteria): ${fc.prdPath}`),
      });
    } finally {
      await dispose();
    }
  });

  test("AC-16 a null reply after successful package creation remains a skipped review", async () => {
    const ctx = context();
    const seen: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowBranchReviewOp);
      seen.push(input);
      return null;
    });
    expect(await runBranchReview(ctx, { seed: "base", facts })).toEqual({ ran: false, why: "unparseable reply" });
    expect(seen).toHaveLength(1);
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).text()).toContain("## Changed files (0)");
  });
});

describe("runBranchReReview with a narrow context", () => {
  test("AC-10/11 writes the fix package and calls workflowReReviewOp", async () => {
    const ctx = context();
    const seen: unknown[] = [];
    const reply = { verdicts: [], newFindings: [] };
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowReReviewOp);
      seen.push(input);
      return reply;
    });
    expect(await runBranchReReview(ctx, { fixBase: "base", findings: [] })).toEqual({ ran: true, verdict: reply });
    expect(seen).toHaveLength(1);
    expect(await Bun.file(join(ctx.runDir, "package-branch-fix.diff")).exists()).toBe(true);
  });
});

describe("runBranchFix with a narrow context", () => {
  test("AC-12/13/14 forwards reportPath, omits the PRD instruction and creates the report", async () => {
    const ctx = context();
    const seen: unknown[] = [];
    const reply: ImplementerReply = { status: "DONE", commits: [], testSummary: "pass", interrupted: false };
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op).toBe(workflowBranchFixOp);
      seen.push(input);
      return reply;
    });
    expect(await Bun.file(ctx.reportPath).exists()).toBe(false);
    expect(await runBranchFix(ctx, { findings: [] })).toEqual({ reply, autoCommitted: false, dirty: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reportPath: ctx.reportPath, prompt: expect.not.stringContaining("the PRD (") });
    expect((await Bun.file(ctx.reportPath).text()).split("\n")[0]).toBe("# Feature report — bot-pr-42");
  });
});

describe("runRepoGates with a narrow context", () => {
  test("AC-15 resolves root gates with the context projectDir and empty package list", async () => {
    const ctx = context();
    const seen: unknown[] = [];
    _featureDeps.resolveGateCommands = async (root, packages) => {
      seen.push([root, packages]);
      return [];
    };
    _featureDeps.runQualityGates = async () => ({ passed: true, ran: [], failing: [], output: "" });
    expect(await runRepoGates(ctx)).toEqual({ summary: { ran: [], failing: [] }, findings: [] });
    expect(seen).toEqual([[ctx.projectDir, []]]);
  });
});
