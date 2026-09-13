import { describe, expect, test } from "bun:test";
import type { Measurement } from "@scripts/analyze-rtk-savings";
import { buildGitCorpus, measure, slice, summarize, TOOL_MAX_BYTES } from "@scripts/analyze-rtk-savings";

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

function m(over: Partial<Measurement>): Measurement {
  return {
    id: "x",
    verb: "diff",
    rawBytes: 1000,
    rtkBytes: 400,
    rawExit: 0,
    rtkExit: 0,
    parity: true,
    rawMs: 10,
    rtkMs: 12,
    sliced: { raw: 1000, rtk: 400 },
    ...over,
  };
}

describe("summarize", () => {
  test("reports percentage saved before and after the slice", () => {
    const [row] = summarize([m({})]);
    expect(row.savedPct).toBeCloseTo(60, 1);
    expect(row.slicedSavedPct).toBeCloseTo(60, 1);
  });

  test("a verb with any exit divergence is disqualified regardless of savings", () => {
    const [row] = summarize([m({ rawExit: 0, rtkExit: 1, parity: false, rtkBytes: 1 })]);
    expect(row.disqualified).toBe(true);
    expect(row.reason).toContain("exit");
  });

  test("savings above the cap do not count as delivered savings", () => {
    // Both saturate the 40 KB slice: full output shrank, what the model sees did not.
    const [row] = summarize([m({ rawBytes: 2_000_000, rtkBytes: 200_000, sliced: { raw: 40_000, rtk: 40_000 } })]);
    expect(row.savedPct).toBeCloseTo(90, 1);
    expect(row.slicedSavedPct).toBeCloseTo(0, 1);
  });

  test("one disqualified sample disqualifies the whole verb", () => {
    const [row] = summarize([m({}), m({ parity: false, rawExit: 0, rtkExit: 2 })]);
    expect(row.disqualified).toBe(true);
  });
});
