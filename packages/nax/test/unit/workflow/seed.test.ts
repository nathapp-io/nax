import { afterEach, describe, expect, test } from "bun:test";
import { makeTestPRD, makeTestStory } from "@test/helpers";
import { resolveSeed } from "@/workflow/seed";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

type GitReply = { stdout: string; exitCode: number };

/** Fake git: answers by the first two argv words; records every call. */
function fakeGit(replies: Record<string, GitReply>): string[][] {
  const calls: string[][] = [];
  _workflowDeps.git = async (args) => {
    calls.push(args);
    return replies[`${args[0]} ${args[1]}`] ?? { stdout: "", exitCode: 1 };
  };
  return calls;
}

const prd = makeTestPRD([makeTestStory({ id: "US-001" })]);

describe("resolveSeed", () => {
  test("merge-base against origin's default branch", async () => {
    const calls = fakeGit({
      "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/develop\n", exitCode: 0 },
      "merge-base refs/remotes/origin/develop": { stdout: "abc123\n", exitCode: 0 },
    });
    expect(await resolveSeed("/repo", prd)).toBe("abc123");
    expect(calls[1]).toEqual(["merge-base", "refs/remotes/origin/develop", "HEAD"]);
  });

  test("no origin HEAD -> merge-base against main", async () => {
    const calls = fakeGit({ "merge-base main": { stdout: "m1\n", exitCode: 0 } });
    expect(await resolveSeed("/repo", prd)).toBe("m1");
    expect(calls.at(-1)).toEqual(["merge-base", "main", "HEAD"]);
  });

  test("origin default has no merge-base -> tries main next", async () => {
    fakeGit({
      "symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/trunk\n", exitCode: 0 },
      "merge-base main": { stdout: "m2\n", exitCode: 0 },
    });
    expect(await resolveSeed("/repo", prd)).toBe("m2");
  });

  test("no merge-base at all -> the first persisted story start ref", async () => {
    fakeGit({});
    const withRef = makeTestPRD([makeTestStory({ id: "US-001" }), makeTestStory({ id: "US-002", storyGitRef: "s2" })]);
    expect(await resolveSeed("/repo", withRef)).toBe("s2");
  });

  test("nothing at all -> null", async () => {
    fakeGit({});
    expect(await resolveSeed("/repo", prd)).toBeNull();
  });
});
