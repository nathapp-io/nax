import { describe, expect, test } from "bun:test";
import { buildGitCorpus } from "@scripts/analyze-rtk-savings";

describe("buildGitCorpus", () => {
  test("covers every read verb the Git tool supports", () => {
    const verbs = new Set(buildGitCorpus().map((e) => e.verb));
    for (const v of ["diff", "log", "show", "status", "blame"]) expect(verbs).toContain(v);
  });

  test("entries carry the flags buildGitArgv always emits", () => {
    const diff = buildGitCorpus().find((e) => e.verb === "diff");
    expect(diff?.argv).toContain("--relative");
    expect(diff?.argv).toContain("--");
  });

  test("includes the log + nameOnly shape the spec calls out", () => {
    const entry = buildGitCorpus().find((e) => e.id === "log-nameonly");
    expect(entry?.argv).toContain("--name-only");
  });

  test("contains no mutating verb", () => {
    const verbs = buildGitCorpus().map((e) => e.verb);
    for (const bad of ["add", "commit", "push", "checkout", "stash"]) expect(verbs).not.toContain(bad);
  });
});
