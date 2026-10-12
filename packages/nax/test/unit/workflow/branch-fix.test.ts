import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import { workflowBranchFixOp } from "@/operations";
import { runBranchFix } from "@/workflow/branch-fix";
import { _workflowDeps } from "@/workflow/step-context";
import type { ImplementerReply, WorkflowFinding } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const findings: WorkflowFinding[] = [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }];
const done: ImplementerReply = { status: "DONE", commits: ["a1"], testSummary: "3 pass", interrupted: false };

function setup(reply: ImplementerReply | Error, dirty: string) {
  const runDir = makeTempDir("wf-bf-");
  dirs.push(runDir);
  const fc = makeFeatureContext({ runDir, reportPath: join(runDir, "feature-report.md") });
  const inputs: unknown[] = [];
  const commits: unknown[][] = [];
  _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
    expect(op.name).toBe(workflowBranchFixOp.name);
    inputs.push(input);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  _workflowDeps.git = async () => ({ stdout: dirty, exitCode: 0 });
  _workflowDeps.autoCommitIfDirty = async (...args: unknown[]) => {
    commits.push(args);
  };
  return { fc, inputs, commits };
}

describe("runBranchFix", () => {
  test("creates feature-report.md, runs the fix op under fixMs, auto-commits leftover edits", async () => {
    const { fc, inputs, commits } = setup(done, " M src/a.ts\n");
    const out = await runBranchFix(fc, { specPath: "spec.md", findings });
    expect(out).toEqual({ reply: done, autoCommitted: true, dirty: false });
    expect(await Bun.file(fc.reportPath).text()).toContain("# Feature report — f");
    expect(inputs[0]).toMatchObject({ timeoutMs: fc.workflow.timeouts.fixMs });
    expect(String((inputs[0] as { prompt: string }).prompt)).toContain("[B1]");
    expect(commits[0]?.slice(0, 4)).toEqual([fc.projectDir, "workflow", "wf-branch-fix", "_run"]);
  });

  test("a clean tree is not committed", async () => {
    const { fc, commits } = setup(done, "");
    expect((await runBranchFix(fc, { findings })).autoCommitted).toBe(false);
    expect(commits).toHaveLength(0);
  });

  test("an interrupted turn still commits its edits: no later round will pick them up", async () => {
    const { fc } = setup({ ...done, interrupted: true }, " M src/a.ts\n");
    expect((await runBranchFix(fc, { findings })).autoCommitted).toBe(true);
  });

  test("a session failure is returned, not thrown; reply.failure likewise", async () => {
    expect((await runBranchFix(setup(new Error("503"), "").fc, { findings })).failure).toBe("503");
    const failed = { ...done, failure: 'Agent "native" failed: quota' };
    expect((await runBranchFix(setup(failed, "").fc, { findings })).failure).toContain("quota");
  });

  test("an existing report is not overwritten", async () => {
    const { fc } = setup(done, "");
    await Bun.write(fc.reportPath, "# Feature report — f\n\n## Branch fix\nearlier\n");
    await runBranchFix(fc, { findings });
    expect(await Bun.file(fc.reportPath).text()).toContain("earlier");
  });

  test("abort rethrows", async () => {
    const ac = new AbortController();
    ac.abort();
    const { fc } = setup(new Error("stopped"), "");
    await expect(runBranchFix({ ...fc, runSignal: ac.signal }, { findings })).rejects.toThrow("stopped");
  });

  test("a thrown session failure with a dirty tree still commits its leftover edits", async () => {
    const { fc, commits } = setup(new Error("503"), " M src/a.ts\n");
    const out = await runBranchFix(fc, { findings });
    expect(out.failure).toBe("503");
    expect(out.autoCommitted).toBe(true);
    expect(commits).toHaveLength(1);
  });

  test("reply.failure with a dirty tree still commits its leftover edits", async () => {
    const failed = { ...done, failure: 'Agent "native" failed: quota' };
    const { fc, commits } = setup(failed, " M src/a.ts\n");
    const out = await runBranchFix(fc, { findings });
    expect(out.failure).toContain("quota");
    expect(out.autoCommitted).toBe(true);
    expect(commits).toHaveLength(1);
  });

  test("a commit that throws resolves with autoCommitted false and dirty true, not a rejection", async () => {
    const { fc } = setup(done, " M src/a.ts\n");
    _workflowDeps.autoCommitIfDirty = async () => {
      throw new Error("commit boom");
    };
    const out = await runBranchFix(fc, { findings });
    expect(out).toEqual({ reply: done, autoCommitted: false, dirty: true });
  });

  test("a listUncommitted (git status) throw resolves with autoCommitted false, not a rejection", async () => {
    const { fc, commits } = setup(done, "");
    _workflowDeps.git = async () => {
      throw new Error("git boom");
    };
    const out = await runBranchFix(fc, { findings });
    expect(out).toEqual({ reply: done, autoCommitted: false, dirty: false });
    expect(commits).toHaveLength(0);
  });
});
