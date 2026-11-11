import { describe, expect, test } from "bun:test";
import { mergeSliceVerdicts, planReviewSlices, type SliceResult } from "@/workflow/branch-review-slices";
import type { BranchReviewVerdict, WorkflowFindingDraft } from "@/workflow/types";

/** `count` files in `dir`, numbered from 1 — the shape a diff's path order gives a directory. */
function files(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${dir}/${i + 1}`);
}

/** 40 files across 7 directories (AC-7): more files than any slice, in neighbourly path order. */
const COUNTS = [7, 6, 6, 6, 5, 5, 5];
const FORTY = ["a", "b", "c", "d", "e", "f", "g"].flatMap((dir, i) => files(dir, COUNTS[i] ?? 0));

/** A parent directory that recurs after an intervening directory: git's path order can do this. */
const INTERLEAVED = ["a/1", "a/2", "a/b/1", "a/3", "b/1", "b/c/1"];

describe("planReviewSlices", () => {
  test("keeps a required set that fits in one slice whole (AC-1)", () => {
    expect(planReviewSlices(["a/1", "a/2"], 15)).toEqual([["a/1", "a/2"]]);
  });

  test("returns one empty slice for an empty required set (AC-2)", () => {
    expect(planReviewSlices([], 15)).toEqual([[]]);
  });

  test("closes a slice when the next directory's group no longer fits (AC-3)", () => {
    expect(planReviewSlices([...files("a", 3), ...files("b", 3)], 4)).toEqual([
      ["a/1", "a/2", "a/3"],
      ["b/1", "b/2", "b/3"],
    ]);
  });

  test("joins neighbouring directories into one slice when they fit (AC-4)", () => {
    expect(planReviewSlices([...files("a", 2), ...files("b", 2)], 4)).toEqual([["a/1", "a/2", "b/1", "b/2"]]);
  });

  test("cuts a group larger than sliceFiles into consecutive slices (AC-5)", () => {
    expect(planReviewSlices(["a/1", ...files("b", 10)], 4)).toEqual([
      ["a/1"],
      ["b/1", "b/2", "b/3", "b/4"],
      ["b/5", "b/6", "b/7", "b/8"],
      ["b/9", "b/10"],
    ]);
  });

  test("groups root files, which share the empty parent directory (AC-6)", () => {
    expect(planReviewSlices(["x.json", "y.json"], 2)).toEqual([["x.json", "y.json"]]);
  });

  test("never returns a slice longer than sliceFiles (AC-7)", () => {
    const slices = planReviewSlices(FORTY, 6);
    expect(FORTY.length).toBe(40);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.every((slice) => slice.length <= 6)).toBe(true);
  });

  test("returns every input path exactly once, in input order (AC-8)", () => {
    for (const required of [FORTY, INTERLEAVED, ["x.json", "y.json"]]) {
      expect(planReviewSlices(required, 6).flat()).toEqual([...required]);
    }
  });

  test("lets the next group join a cut group's last, shorter slice (AC-19)", () => {
    expect(planReviewSlices([...files("a", 6), "b/1"], 4)).toEqual([
      ["a/1", "a/2", "a/3", "a/4"],
      ["a/5", "a/6", "b/1"],
    ]);
  });
});

/** A branch-review verdict as an op parses it, with every list empty unless overridden. */
function verdict(over: Partial<BranchReviewVerdict> = {}): BranchReviewVerdict {
  return {
    spec: "pass",
    quality: "approved",
    findings: [],
    cannotVerify: [],
    inspectedFiles: [],
    minorTriage: [],
    ...over,
  };
}

/** One part as `runBranchReview` builds it: its files, the slice's verdict, and why it did not run. */
function part(files: readonly string[], result: BranchReviewVerdict | null, why?: string): SliceResult {
  return { files, verdict: result, ...(why !== undefined ? { why } : {}) };
}

/** A finding carrying the given issue text — the merge concatenates, so the text is its identity. */
function finding(issue: string): WorkflowFindingDraft {
  return { kind: "quality", severity: "minor", issue };
}

/**
 * A verdict parsed from a reply that carried no `inspectedFiles`: required in the type, absent at
 * runtime — which is why the merge reads `inspectedFiles ?? []` everywhere.
 */
function withoutInspectedFiles(over: Partial<BranchReviewVerdict> = {}): BranchReviewVerdict {
  const { inspectedFiles: _omitted, ...rest } = verdict(over);
  const parsed: BranchReviewVerdict = JSON.parse(JSON.stringify(rest));
  return parsed;
}

describe("mergeSliceVerdicts", () => {
  test("returns null when every slice failed to run (AC-9)", () => {
    expect(mergeSliceVerdicts([part(["a/1"], null, "timeout"), part(["b/1"], null, "boom")])).toBeNull();
  });

  test("fails spec when any slice that ran did (AC-10)", () => {
    const merged = mergeSliceVerdicts([part(["a/1"], verdict()), part(["b/1"], verdict({ spec: "fail" }))]);
    expect(merged?.spec).toBe("fail");
  });

  test("reports changes when any slice that ran did (AC-11)", () => {
    const merged = mergeSliceVerdicts([part(["a/1"], verdict()), part(["b/1"], verdict({ quality: "changes" }))]);
    expect(merged?.quality).toBe("changes");
  });

  test("concatenates findings in slice order (AC-12)", () => {
    const first = finding("slice one drift");
    const second = finding("slice two drift");
    const merged = mergeSliceVerdicts([
      part(["a/1"], verdict({ findings: [first] })),
      part(["b/1"], verdict({ findings: [second] })),
    ]);
    expect(merged?.findings).toEqual([first, second]);
  });

  test("drops an exact duplicate cannotVerify entry (AC-13)", () => {
    const merged = mergeSliceVerdicts([
      part(["a/1"], verdict({ cannotVerify: ["no staging env", "flaky suite"] })),
      part(["b/1"], verdict({ cannotVerify: ["no staging env"] })),
    ]);
    expect(merged?.cannotVerify).toEqual(["no staging env", "flaky suite"]);
  });

  test("unions inspectedFiles in first-appearance order (AC-14)", () => {
    const merged = mergeSliceVerdicts([
      part(["a/1", "a/2"], verdict({ inspectedFiles: ["a/1", "a/2"] })),
      part(["a/2", "b/1"], verdict({ inspectedFiles: ["a/2", "b/1"] })),
    ]);
    expect(merged?.inspectedFiles).toEqual(["a/1", "a/2", "b/1"]);
  });

  test("promotes a minor any slice wanted fixed now (AC-15)", () => {
    const merged = mergeSliceVerdicts([
      part(["a/1"], verdict({ minorTriage: [{ id: "M1", decision: "leave" }] })),
      part(["b/1"], verdict({ minorTriage: [{ id: "M1", decision: "fix-now" }] })),
    ]);
    expect(merged?.minorTriage).toEqual([{ id: "M1", decision: "fix-now" }]);
  });

  test("records a slice that did not run with its files and why (AC-16)", () => {
    const merged = mergeSliceVerdicts([part(["a/1"], verdict()), part(["b/1", "b/2"], null, "timeout")]);
    expect(merged?.slices?.[1]).toEqual({ files: ["b/1", "b/2"], inspectedFiles: [], ran: false, why: "timeout" });
  });

  test("takes spec, quality and findings from the slices that ran (AC-17)", () => {
    const spec = finding("spec gap");
    const merged = mergeSliceVerdicts([
      part(["a/1"], verdict({ spec: "fail", quality: "changes", findings: [spec] })),
      part(["b/1"], null, "boom"),
    ]);
    expect(merged?.spec).toBe("fail");
    expect(merged?.quality).toBe("changes");
    expect(merged?.findings).toEqual([spec]);
  });

  test("records each ran slice's own inspectedFiles on its slice (AC-18)", () => {
    const merged = mergeSliceVerdicts([
      part(["a/1", "a/2"], verdict({ inspectedFiles: ["a/1"] })),
      part(["b/1"], verdict({ inspectedFiles: ["b/1"] })),
    ]);
    expect(merged?.slices?.[0]).toEqual({ files: ["a/1", "a/2"], inspectedFiles: ["a/1"], ran: true });
  });

  test("returns a lone ran part's verdict object itself, adding no slices field (AC-20)", () => {
    const only = verdict({ inspectedFiles: ["a/1"] });
    const merged = mergeSliceVerdicts([part(["a/1"], only)]);
    expect(merged).toBe(only);
    if (merged === null) throw new Error("the merge must return the lone ran verdict");
    expect("slices" in merged).toBe(false);
  });

  test("reads a verdict with no inspectedFiles as empty, keeping the other slice's list (AC-21)", () => {
    const merged = mergeSliceVerdicts([
      part(["a/1"], withoutInspectedFiles()),
      part(["b/1"], verdict({ inspectedFiles: ["b/1"] })),
    ]);
    expect(merged?.inspectedFiles).toEqual(["b/1"]);
  });
});
