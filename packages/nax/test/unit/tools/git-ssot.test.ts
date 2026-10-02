import { describe, expect, test } from "bun:test";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

/**
 * nax#2007 — nax writes run state under `.nax/`, and during a run it is
 * git-tracked, so an unscoped Git call reported it back to the agent as its own
 * diff. The fix narrows only the DEFAULT view: a caller that names a path gets
 * exactly what it asked for. `blame` is exempt because git rejects exclude
 * pathspecs there and exits 128.
 */
describe("buildGitArgv — nax-owned paths are excluded from the default view", () => {
  const GIT_EXCLUDES = [":(exclude).nax", ":(glob,exclude)**/.nax/**"];

  test("the shared SSOT constant is the git exclude form the tool uses", () => {
    expect([...NAX_OWNED_GIT_EXCLUDE_PATHSPECS]).toEqual(GIT_EXCLUDES);
  });
});
