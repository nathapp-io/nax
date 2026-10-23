/**
 * US-005: `storyChangedFiles` — the changed-file evidence a continue turn is told about (spec
 * § US-005). The list is what the still-warm session reads after it was cut off, so it is the
 * union of the committed and the uncommitted answers, with nax's own artifacts dropped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertNaxError, makeStepContext } from "@test/helpers";
import { storyChangedFiles } from "@/workflow/no-work";
import { _workflowDeps } from "@/workflow/step-context";

const origGit = _workflowDeps.git;
afterEach(() => {
  _workflowDeps.git = origGit;
});

/**
 * Answer `git diff --name-only` and `git status --porcelain` from one stub, recording each argv.
 * `exitCode` on the diff arm is what AC-2 reads; the status arm stays green.
 */
function stubGit(diff: { stdout?: string; stderr?: string; exitCode?: number }, status: string): string[][] {
  const calls: string[][] = [];
  _workflowDeps.git = async (args) => {
    calls.push(args);
    if (args[0] === "diff") {
      const exitCode = diff.exitCode ?? 0;
      return { stdout: diff.stdout ?? "", ...(diff.stderr ? { stderr: diff.stderr } : {}), exitCode };
    }
    return { stdout: status, exitCode: 0 };
  };
  return calls;
}

describe("storyChangedFiles", () => {
  test("AC-1: the union of the diff and the dirty list, nax-owned paths dropped and deduplicated", async () => {
    const calls = stubGit({ stdout: "src/a.ts\n.nax/features/f/x.md\n" }, " M src/a.ts\n?? src/b.ts\n");
    const sc = makeStepContext({ projectDir: "/repo", base: "base1" });

    expect(await storyChangedFiles(sc)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls[0]).toEqual(["diff", "--name-only", "base1..HEAD"]);
    expect(calls[1]?.[0]).toBe("status");
  });

  test("AC-1: an uncommitted-only file is still reported, and a nax-owned one is not", async () => {
    stubGit({ stdout: "" }, "?? src/new.ts\n?? .nax-keep/x.json\n?? .nax/features/f/y.md\n");
    expect(await storyChangedFiles(makeStepContext({ projectDir: "/repo" }))).toEqual(["src/new.ts"]);
  });

  test("AC-2: a failing git diff rejects instead of answering an empty list", async () => {
    stubGit({ stderr: "bad revision", exitCode: 128 }, "");
    const err = await storyChangedFiles(makeStepContext({ projectDir: "/repo", base: "nope" })).catch(
      (e: unknown) => e,
    );
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_GIT_FAILED");
    expect(err.message).toContain("bad revision");
  });

  test("a failing git status rejects too — an unreadable tree is never a clean one", async () => {
    _workflowDeps.git = async (args) =>
      args[0] === "diff" ? { stdout: "src/a.ts\n", exitCode: 0 } : { stdout: "", stderr: "boom", exitCode: 128 };
    const err = await storyChangedFiles(makeStepContext({ projectDir: "/repo" })).catch((e: unknown) => e);
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_GIT_FAILED");
  });
});
