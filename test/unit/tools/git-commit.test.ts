import { describe, expect, test } from "bun:test";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import { GIT_ESCAPE_FLAGS } from "@/tools/git";
import { buildCommitArgvs } from "@/tools/git-commit";
import { _resetRegistryForTest, getCodingTool } from "@/tools/registry";
import { _resetBuiltinsForTest, registerBuiltinCodingTools } from "@/tools/runtime";

describe("buildCommitArgvs", () => {
  test("stages the named paths and commits with the message", () => {
    const built = buildCommitArgvs({ message: "feat(US-1): thing", paths: ["src/a.ts"] });
    expect(built).toEqual({
      add: ["add", "--", "src/a.ts"],
      commit: ["commit", "-m", "feat(US-1): thing"],
    });
  });

  test("supports a multi-line body, which the implementer prompt requires", () => {
    const built = buildCommitArgvs({ message: "feat: x\n\nException (b): contract drift.", paths: ["a.ts"] });
    expect(built).toMatchObject({ commit: ["commit", "-m", "feat: x\n\nException (b): contract drift."] });
  });

  test("refuses a path that would parse as a flag", () => {
    expect(buildCommitArgvs({ message: "m", paths: ["--git-dir=/etc"] })).toEqual({
      error: 'path "--git-dir=/etc" may not begin with "-"',
    });
  });

  test("refuses an empty message rather than committing an empty subject", () => {
    expect(buildCommitArgvs({ message: "  ", paths: ["a.ts"] })).toEqual({
      error: "message must be a non-empty string",
    });
  });

  test("requires at least one path -- it never stages the whole tree implicitly", () => {
    expect(buildCommitArgvs({ message: "m", paths: [] })).toEqual({ error: "paths must name at least one file" });
  });

  test("emits no escape flag in either argv", () => {
    const built = buildCommitArgvs({ message: "-c core.pager=id", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(built.add).not.toContain(flag);
      expect(built.commit).not.toContain(flag);
    }
  });

  test("a message that looks like a flag is still a message, never an argv element of its own", () => {
    const built = buildCommitArgvs({ message: "--work-tree=/etc", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    expect(built.commit).toEqual(["commit", "-m", "--work-tree=/etc"]);
    expect(built.commit.indexOf("--work-tree=/etc")).toBe(2);
  });

  test("registers as a builtin", () => {
    _resetRegistryForTest();
    _resetBuiltinsForTest();
    registerBuiltinCodingTools();
    expect(getCodingTool("GitCommit")?.name).toBe("GitCommit");
  });

  test("is NOT in the default grant -- mutation is always explicit", () => {
    expect(DEFAULT_CODING_TOOLS).not.toContain("GitCommit");
  });
});
