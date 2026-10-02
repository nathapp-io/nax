import { describe, expect, test } from "bun:test";
import { GIT_ESCAPE_FLAGS } from "#src/tools/git-flags/index";

describe("GIT_ESCAPE_FLAGS", () => {
  test("bans every flag that can retarget git or execute code", () => {
    // -c is included because `-c core.pager=<cmd>` is code execution.
    expect([...GIT_ESCAPE_FLAGS].sort()).toEqual(["--exec-path", "--git-dir", "--work-tree", "-C", "-c"].sort());
  });
});
