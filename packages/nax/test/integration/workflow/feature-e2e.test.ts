import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAdviceDecision,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { ForgeRunResult } from "@/forge";
import { workflowBranchFixOp, workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { _ciWaitDeps } from "@/workflow/ci-wait";
import { runWorkflowFeature } from "@/workflow/feature";
import { _featureContextDeps } from "@/workflow/feature-context";
import { _featureDeps } from "@/workflow/feature-deps";
import { workflowRunDir } from "@/workflow/paths";
import { newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const saved = {
  wf: { ..._workflowDeps },
  feature: { ..._featureDeps },
  ctx: { ..._featureContextDeps },
  ci: { ..._ciWaitDeps },
};
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, saved.wf);
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_featureContextDeps, saved.ctx);
  Object.assign(_ciWaitDeps, saved.ci);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`command failed (${code}): ${args.join(" ")}\n${stderr}`);
}

async function setup() {
  const repo = makeTempDir("wf-fe2e-repo-");
  const out = makeTempDir("wf-fe2e-out-");
  dirs.push(repo, out);
  await sh(repo, "git", "init", "-q", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "seed");
  await sh(repo, "git", "checkout", "-qb", "feat/x");
  await Bun.write(join(repo, "b.ts"), "export const b = 2;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "feat: story work");

  const config = makeNaxConfig({ execution: { mode: "workflow" }, outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: repo });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  // A prior story run left a closed record and one deferred minor.
  const storyRun = workflowRunDir(repo, prd.feature, "run-stories");
  await upsertStoryRecord(
    storyRun,
    { runId: "run-stories", feature: prd.feature },
    {
      ...newStoryRecord("US-001", 5, "t"),
      state: "complete",
      reason: "clean",
      phase: "closed",
      round: 1,
    },
  );
  await Bun.write(join(storyRun, "ledger.md"), "# ledger\nUS-001: deferred-minor: rename tmp var\n");

  _featureContextDeps.buildRunDispatchAskWiring = async () => ({
    askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }) },
    commandShadow: undefined,
    dispose: async () => {},
  });
  const gh: string[][] = [];
  _featureDeps.detectForge = async () => "github";
  const pushes: unknown[][] = [];
  const gateRuns: unknown[][] = [];
  _featureDeps.commitAndPush = async (...args: unknown[]) => {
    pushes.push(args);
    return { committed: false, pushed: true };
  };
  _featureDeps.resolveGateCommands = async () => [];
  _featureDeps.runQualityGates = async (...args: unknown[]) => {
    gateRuns.push(args);
    return { passed: true, ran: ["test"], failing: [], output: "[test] exit=0" };
  };
  _featureDeps.forge = {
    readText: async () => null,
    run: async (cmd): Promise<ForgeRunResult> => {
      gh.push(cmd);
      const sub = `${cmd[1]} ${cmd[2]}`;
      if (sub === "pr list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (sub === "pr create") return { exitCode: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" };
      if (sub === "pr view")
        return { exitCode: 0, stdout: '{"isDraft":true,"url":"https://github.com/o/r/pull/9"}', stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) =>
    cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "checks"
      ? { exitCode: 0, stdout: '[{"name":"t","state":"SUCCESS","bucket":"pass"}]', stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" };

  const approver: Advisor = {
    advise: async () => ({ decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) }),
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  _workflowDeps.createAdvisor = () => approver;
  _workflowDeps.readTrustedDecisions = async () => [];
  const ops: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp(async (op) => {
    ops.push(op.name);
    if (op.name === workflowBranchReviewOp.name) {
      return {
        spec: "pass",
        quality: "changes",
        // US-003: the fixture's only changed file after the seed (b.ts) must be reported read,
        // or the incomplete-review reason turns the expected "ready" into a draft.
        inspectedFiles: ["b.ts"],
        findings: [{ kind: "quality", severity: "important", issue: "b.ts never exported from the barrel" }],
        cannotVerify: [],
        minorTriage: [{ id: "M1", decision: "fix-now" }],
      };
    }
    if (op.name === workflowBranchFixOp.name) {
      await Bun.write(join(repo, "index.ts"), 'export * from "./b";\n');
      await sh(repo, "git", "add", ".");
      await sh(repo, "git", "commit", "-qm", "fix: export b");
      return { status: "DONE", commits: [], testSummary: "1 pass", interrupted: false };
    }
    if (op.name === workflowReReviewOp.name) {
      return {
        verdicts: [
          { id: "B1", addressed: true, note: "" },
          { id: "M1", addressed: true, note: "" },
        ],
        newFindings: [],
      };
    }
    throw new Error(`unexpected op ${op.name}`);
  });
  const input = {
    runtime,
    config,
    prd,
    feature: prd.feature,
    workdir: repo,
    branch: "feat/x",
    runId: runtime.runId,
    agentName: "claude",
  };
  return { repo, out, input, gh, ops, pushes, gateRuns, runDir: workflowRunDir(repo, prd.feature, runtime.runId) };
}

describe("workflow feature end to end", () => {
  test("review -> one fix -> re-review -> gates -> push -> draft PR -> CI green -> approved -> ready", async () => {
    const { input, gh, ops, runDir, pushes, gateRuns } = await setup();
    const result = await runWorkflowFeature(input);
    expect(gateRuns.length).toBeGreaterThanOrEqual(2); // repo gates, then final gates after the fix
    expect(pushes).toHaveLength(1);
    expect(result).toEqual({ passed: true, outcome: "ready", url: "https://github.com/o/r/pull/9", reasons: [] });
    expect(ops).toEqual([workflowBranchReviewOp.name, workflowBranchFixOp.name, workflowReReviewOp.name]);
    expect(gh.some((c) => c.join(" ").startsWith("gh pr create") && c.includes("--draft"))).toBe(true);
    expect(gh.some((c) => c.join(" ").startsWith("gh pr ready"))).toBe(true);
    const record = (await readResult(runDir))?.featureWorkflow;
    expect(record).toMatchObject({ step: "done", outcome: "ready", ci: "green", reviewRan: true, fixRan: true });
    expect(record?.minors).toEqual([{ id: "M1", storyId: "US-001", text: "rename tmp var", triage: "fix-now" }]);
    for (const f of ["branch-review.json", "branch-rereview.json", "feature-report.md", "package-branch.diff"]) {
      expect(await Bun.file(join(runDir, f)).exists()).toBe(true);
    }
    expect(await Bun.file(join(runDir, "ledger.md")).text()).toContain(
      "_run: feature ready https://github.com/o/r/pull/9",
    );
  });

  test("a second run at the same HEAD is already finished: no review, no forge calls", async () => {
    const first = await setup();
    await runWorkflowFeature(first.input);
    const ghBefore = first.gh.length;
    const opsBefore = first.ops.length;
    // A second run is a new runtime with its own run id, as the runner builds one per run (nax#2482).
    const second = makeTestRuntime({ config: first.input.config, workdir: first.repo });
    runtimes.push(second);
    const again = await runWorkflowFeature({ ...first.input, runtime: second, runId: second.runId });
    expect(again?.outcome).toBe("already-finished");
    expect(first.gh.length).toBe(ghBefore);
    expect(first.ops.length).toBe(opsBefore);
  });

  /** B3 (#2496): the first fix introduces B2 in src/a.ts, which sits inside the fix diff. */
  function scriptB3(repo: string, secondAddressed: boolean) {
    const fixes: string[] = [];
    let reReviews = 0;
    _workflowDeps.git = async (args, cwd) =>
      args[0] === "diff" && args[1] === "--name-only" ? { stdout: "src/a.ts\n", exitCode: 0 } : saved.wf.git(args, cwd);
    _workflowDeps.callOp = makeScriptedCallOp(async (op) => {
      if (op.name === workflowBranchReviewOp.name) {
        return {
          spec: "pass",
          quality: "changes",
          // US-003: b.ts is the one file this fixture changes after the seed.
          inspectedFiles: ["b.ts"],
          findings: [{ kind: "quality", severity: "important", issue: "cap missing", file: "src/a.ts" }],
          cannotVerify: [],
          minorTriage: [],
        };
      }
      if (op.name === workflowBranchFixOp.name) {
        const file = `fix${fixes.length + 1}.ts`;
        fixes.push(file);
        await Bun.write(join(repo, file), `export const f${fixes.length} = 1;\n`);
        await sh(repo, "git", "add", ".");
        await sh(repo, "git", "commit", "-qm", `fix: round ${fixes.length}`);
        return { status: "DONE", commits: [], testSummary: "1 pass", interrupted: false };
      }
      if (op.name === workflowReReviewOp.name) {
        reReviews += 1;
        if (reReviews === 1) {
          return {
            verdicts: [{ id: "B1", addressed: true, note: "" }],
            newFindings: [{ kind: "quality", severity: "important", issue: "fix broke published()", file: "src/a.ts" }],
          };
        }
        return { verdicts: [{ id: "B2", addressed: secondAddressed, note: "" }], newFindings: [] };
      }
      throw new Error(`unexpected op ${op.name}`);
    });
    return fixes;
  }

  test("B3: a defect the branch fix introduced is fixed by the second pass (#2496)", async () => {
    const { input, repo, runDir } = await setup();
    const fixes = scriptB3(repo, true);
    await runWorkflowFeature(input);
    expect(fixes).toHaveLength(2);
    const file = await readResult(runDir);
    expect(file?.verdict?.openItems).toEqual([]);
    expect(file?.featureWorkflow?.fixRounds).toBe(2);
  });

  test("B3: second re-review still failing ends draft with the full open item", async () => {
    const { input, repo, runDir, gh } = await setup();
    scriptB3(repo, false);
    await runWorkflowFeature(input);
    const verdict = (await readResult(runDir))?.verdict;
    expect(verdict).toMatchObject({ outcome: "draft", workflowPassed: false });
    expect(verdict?.openItems[0]).toMatchObject({
      id: "B2",
      file: "src/a.ts",
      issue: "fix broke published()",
      ruling: { action: "hold" },
    });
    const create = gh.find((c) => c.join(" ").startsWith("gh pr create"));
    const body = create?.[create.indexOf("--body") + 1] ?? "";
    expect(body).toContain("## Before marking ready");
    expect(body).toContain("**B2**");
  });
});
