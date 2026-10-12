import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestContext,
  makeTestRuntime,
} from "@test/helpers";
import {
  fullSuiteGateOp,
  lintCheckOp,
  typecheckCheckOp,
  verifyScopedOp,
  workflowImplementOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";
import { _workflowDeps } from "@/workflow/step-context";

const originalDeps = { ..._workflowDeps };
const originalStage = { ..._workflowStageDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_workflowDeps, originalDeps);
  Object.assign(_workflowStageDeps, originalStage);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`command failed (${code}): ${args.join(" ")}\n${stderr}`);
}

async function setup() {
  const repo = makeTempDir("wf-e2e-repo-");
  const out = makeTempDir("wf-e2e-out-");
  dirs.push(repo, out);
  await sh(repo, "git", "init", "-q");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "seed");
  const config = makeNaxConfig({ execution: { mode: "workflow" }, quality: { commands: {} }, outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: repo });
  const ctx = makeTestContext({ config, rootConfig: config, workdir: repo, projectDir: repo, runtime });
  _workflowStageDeps.buildWorkflowCallContext = async () => ({
    callCtx: makeMockCallContext(),
    dispose: async () => {},
  });
  return { repo, out, ctx };
}

function fakeAgent(repo: string, reviews: unknown[]): string[] {
  const queue = [...reviews];
  const seen: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp(async (op) => {
    seen.push(op.name);
    if (op.name === workflowImplementOp.name) {
      await Bun.write(join(repo, `impl-${seen.length}.ts`), "export const x = 1;\n");
      await sh(repo, "git", "add", ".");
      await sh(repo, "git", "commit", "-qm", "feat: work");
      return { status: "DONE", commits: [], testSummary: "1 pass", interrupted: false };
    }
    if (op.name === workflowStoryReviewOp.name) return queue.shift() ?? null;
    if (op.name === workflowReReviewOp.name) {
      return { verdicts: [{ id: "F1", addressed: true, note: "" }], newFindings: [] };
    }
    if (op.name === lintCheckOp.name || op.name === typecheckCheckOp.name) {
      return { success: true, status: "skipped", findings: [], durationMs: 1 };
    }
    if (op.name === verifyScopedOp.name) {
      return { success: true, status: "passed", findings: [], durationMs: 1, passCount: 1, isFullSuite: false };
    }
    if (op.name === fullSuiteGateOp.name) {
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, findings: [], rawOutput: "" };
    }
    throw new Error(`unexpected op ${op.name}`);
  });
  return seen;
}

describe("workflow story end to end", () => {
  test("review finding -> one warm fix -> re-review -> complete; artifacts written", async () => {
    const { repo, out, ctx } = await setup();
    const seen = fakeAgent(repo, [
      {
        spec: "fail",
        quality: "approved",
        findings: [{ severity: "important", kind: "spec", acId: "AC-1", issue: "AC-1 untested" }],
        cannotVerify: [],
      },
    ]);
    const result = await workflowStage.execute(ctx);
    expect(result).toEqual({ action: "continue" });
    expect(seen.filter((n) => n === workflowImplementOp.name)).toHaveLength(2);
    const runDir = join(out, "workflow", ctx.prd.feature, ctx.runtime.runId);
    const storyDir = join(runDir, ctx.story.id);
    const ledger = await Bun.file(join(runDir, "ledger.md")).text();
    expect(ledger).toContain(`${ctx.story.id}: fix round 1/5 (1 open: F1)`);
    expect(ledger).toContain(`${ctx.story.id}: complete (1 round(s), clean)`);
    expect(await Bun.file(join(storyDir, "brief.md")).exists()).toBe(true);
    expect(await Bun.file(join(storyDir, "package-0.diff")).text()).toContain("feat: work");
    expect(await Bun.file(join(storyDir, "package-1.diff")).exists()).toBe(true);
    const resultFile = await Bun.file(join(runDir, "result.json")).json();
    expect(resultFile.stories[ctx.story.id]).toMatchObject({ state: "complete", round: 1, phase: "closed" });
    expect(ctx.agentResult?.success).toBe(true);
  });

  test("unparseable review -> review-skipped, story still completes", async () => {
    const { repo, out, ctx } = await setup();
    fakeAgent(repo, [null]);
    await workflowStage.execute(ctx);
    const ledger = await Bun.file(join(out, "workflow", ctx.prd.feature, ctx.runtime.runId, "ledger.md")).text();
    expect(ledger).toContain("review-skipped (story review: unparseable reply)");
    expect(ledger).toContain("complete (0 round(s), clean, unreviewed)");
  });
});
