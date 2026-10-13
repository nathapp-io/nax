import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeScriptedCallOp, makeStepContext, makeTempDir } from "@test/helpers";
import { workflowReReviewOp, workflowStoryReviewOp } from "@/operations";
import { runReReview } from "@/workflow/re-review";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function makeSc(over: Partial<StepContext> = {}): StepContext {
  const storyDir = makeTempDir("wf-review-h-");
  dirs.push(storyDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeStepContext({ storyDir, base: "base0", ...over });
}

const VERDICT = { spec: "pass", quality: "approved", findings: [], cannotVerify: [], inspectedFiles: [] } as const;

describe("review artifact write failures", () => {
  test("a review.json write failure still returns the verdict", async () => {
    const sc = makeSc();
    await mkdir(join(sc.storyDir, "review.json"), { recursive: true }); // a directory: the write fails
    _workflowDeps.callOp = makeScriptedCallOp(() => VERDICT);
    expect(await runStoryReview(sc, [])).toEqual({ ran: true, verdict: VERDICT });
  });

  test("a rereview-N.json write failure still returns the verdict", async () => {
    const sc = makeSc();
    await mkdir(join(sc.storyDir, "rereview-2.json"), { recursive: true });
    const verdict = { verdicts: [], newFindings: [] };
    _workflowDeps.callOp = makeScriptedCallOp(() => verdict);
    expect(await runReReview(sc, 2, [], "fix-base")).toEqual({ ran: true, verdict });
  });
});

describe("review package failure under abort", () => {
  test("rethrows instead of reporting a skipped review", async () => {
    const ac = new AbortController();
    ac.abort();
    const sc = makeSc({ runSignal: ac.signal });
    _workflowDeps.git = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });
    _workflowDeps.callOp = makeScriptedCallOp(() => VERDICT);
    await expect(runStoryReview(sc, [])).rejects.toThrow("bad revision");
  });
});

describe("review step time limit", () => {
  test("a review that outlives reviewMs resolves to { ran: false, why: timeout }", async () => {
    const base = makeSc();
    const sc = makeStepContext({
      ...base,
      workflow: { ...base.workflow, timeouts: { ...base.workflow.timeouts, reviewMs: 20 } },
    });
    const seenOps: string[] = [];
    _workflowDeps.callOp = makeScriptedCallOp(
      (op, _input, ctx) =>
        new Promise((_resolve, reject) => {
          seenOps.push(op.name);
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted by limit")), { once: true });
        }),
    );
    expect(await runStoryReview(sc, [])).toEqual({ ran: false, why: "timeout" });
    expect(seenOps).toEqual([workflowStoryReviewOp.name]);
    expect(await runReReview(sc, 1, [], "fix-base")).toEqual({ ran: false, why: "timeout" });
    expect(seenOps).toEqual([workflowStoryReviewOp.name, workflowReReviewOp.name]);
  });
});
