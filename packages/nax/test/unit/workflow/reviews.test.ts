import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { WorkflowReReviewInput } from "@/operations";
import { workflowReReviewOp, workflowStoryReviewOp } from "@/operations";
import type { Operation } from "@/operations/types";
import { runReReview } from "@/workflow/re-review";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";
import type { StoryReviewVerdict } from "@/workflow/types";
import { makeStepContext } from "./step-context-helper";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function makeSc(over: Partial<StepContext> = {}): StepContext {
  const storyDir = makeTempDir("wf-review-");
  dirs.push(storyDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeStepContext({ storyDir, base: "base0", ...over });
}

/** Fakes callOp: returns `result` (or throws it when it is an Error) for the named op only. */
function fakeOp(name: string, result: unknown, seen: unknown[] = []): void {
  _workflowDeps.callOp = async <I, O, C>(_ctx: unknown, op: Operation<I, O, C>, input: I): Promise<O> => {
    expect(op.name).toBe(name);
    seen.push(input);
    if (result instanceof Error) throw result;
    return result as O;
  };
}

const failingGit = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });

describe("runStoryReview", () => {
  test("writes package-0.diff and review.json; returns the verdict", async () => {
    const sc = makeSc();
    const verdict: StoryReviewVerdict = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };
    fakeOp(workflowStoryReviewOp.name, verdict);
    const out = await runStoryReview(sc, []);
    expect(out).toEqual({ ran: true, verdict });
    expect(await Bun.file(join(sc.storyDir, "package-0.diff")).exists()).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "review.json")).json()).toEqual(verdict);
  });

  test("unparseable reply (null) -> not run", async () => {
    const sc = makeSc();
    fakeOp(workflowStoryReviewOp.name, null);
    expect(await runStoryReview(sc, [])).toEqual({ ran: false, why: "unparseable reply" });
  });

  test("thrown error -> not run with the message", async () => {
    const sc = makeSc();
    fakeOp(workflowStoryReviewOp.name, new Error("503"));
    expect(await runStoryReview(sc, [])).toEqual({ ran: false, why: "503" });
  });

  test("abort rethrows", async () => {
    const ac = new AbortController();
    ac.abort();
    const sc = makeSc({ runSignal: ac.signal });
    fakeOp(workflowStoryReviewOp.name, new Error("stopped"));
    await expect(runStoryReview(sc, [])).rejects.toThrow("stopped");
  });

  test("review package failure -> not run, op never called", async () => {
    const sc = makeSc();
    _workflowDeps.git = failingGit;
    const seen: unknown[] = [];
    fakeOp(workflowStoryReviewOp.name, null, seen);
    const out = await runStoryReview(sc, []);
    expect(out.ran).toBe(false);
    expect(!out.ran && out.why).toStartWith("review package failed: ");
    expect(!out.ran && out.why).toContain("bad revision");
    expect(seen).toHaveLength(0);
  });
});

describe("runReReview", () => {
  test("scopes the package to fixBase and passes the open ids", async () => {
    const sc = makeSc();
    const gitCalls: string[][] = [];
    _workflowDeps.git = async (args) => {
      gitCalls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    const seen: unknown[] = [];
    fakeOp(workflowReReviewOp.name, { verdicts: [], newFindings: [] }, seen);
    await runReReview(sc, 2, [{ id: "F3", kind: "quality", severity: "important", issue: "x" }], "fix-base");
    expect((seen[0] as WorkflowReReviewInput).openIds).toEqual(["F3"]);
    expect(gitCalls.some((a) => a.includes("fix-base..HEAD"))).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "package-2.diff")).exists()).toBe(true);
    expect(await Bun.file(join(sc.storyDir, "rereview-2.json")).exists()).toBe(true);
  });

  test("review package failure -> not run, op never called", async () => {
    const sc = makeSc();
    _workflowDeps.git = failingGit;
    const seen: unknown[] = [];
    fakeOp(workflowReReviewOp.name, null, seen);
    const out = await runReReview(sc, 1, [], "fix-base");
    expect(out.ran).toBe(false);
    expect(!out.ran && out.why).toStartWith("review package failed: ");
    expect(seen).toHaveLength(0);
  });
});
