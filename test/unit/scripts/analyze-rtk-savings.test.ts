import { describe, expect, test } from "bun:test";
import { buildGitCorpus, measure, slice, TOOL_MAX_BYTES } from "@scripts/analyze-rtk-savings";

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

describe("slice", () => {
  test("models nax's post-truncation delivered size", () => {
    expect(slice(10)).toBe(10);
    expect(slice(TOOL_MAX_BYTES + 5_000)).toBe(TOOL_MAX_BYTES);
  });
});

describe("measure", () => {
  test("reports parity when both runs exit the same", async () => {
    const m = await measure({ id: "t", kind: "shell", command: "echo hi", verb: "echo" }, process.cwd());
    expect(m.rawExit).toBe(0);
    expect(m.parity).toBe(m.rawExit === m.rtkExit);
    expect(m.rawBytes).toBeGreaterThan(0);
  });

  test("a non-zero exit is preserved, not swallowed", async () => {
    const m = await measure({ id: "f", kind: "shell", command: "exit 3", verb: "exit" }, process.cwd());
    expect(m.rawExit).toBe(3);
  });
});
