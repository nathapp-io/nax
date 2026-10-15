/** US-004 (nax#2524): absorbing a re-review verdict — PARTIAL residuals keep the id, restatements are dropped. */
import { describe, expect, test } from "bun:test";
import { absorbReReviewVerdict } from "@/workflow/re-review-absorb";
import type { ReReviewResidual, ReReviewVerdict, WorkflowFinding } from "@/workflow/types";

const finding = (over: Partial<WorkflowFinding> = {}): WorkflowFinding => ({
  id: "B1",
  kind: "spec",
  severity: "critical",
  issue: "the original issue",
  file: "a.ts",
  line: 53,
  observed: "verbatim proof the reviewer quoted",
  ...over,
});

const verdictWith = (
  residual: ReReviewResidual | undefined,
  over: Partial<{ id: string; addressed: boolean; newFindings: ReReviewVerdict["newFindings"] }> = {},
): ReReviewVerdict => ({
  verdicts: [
    {
      id: over.id ?? "B1",
      addressed: over.addressed ?? false,
      note: "one sentence",
      ...(residual ? { residual } : {}),
    },
  ],
  newFindings: over.newFindings ?? [],
});

const draft = (issue: string, file?: string, line?: number) => ({
  kind: "spec" as const,
  severity: "critical" as const,
  issue,
  ...(file !== undefined ? { file } : {}),
  ...(line !== undefined ? { line } : {}),
});

describe("absorbReReviewVerdict — PARTIAL keeps the finding open (US-004)", () => {
  test("keeps the same id with the residual as its issue (AC-5)", () => {
    const { open } = absorbReReviewVerdict([finding()], verdictWith({ issue: "symlinks still bypass" }));
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe("B1");
    expect(open[0]?.issue).toBe("symlinks still bypass");
  });

  test("carries the residual's suggestion onto the open finding (AC-6)", () => {
    const { open } = absorbReReviewVerdict(
      [finding({ suggestion: "old advice" })],
      verdictWith({ issue: "still bypass", suggestion: "resolve the symlink first" }),
    );
    expect(open[0]?.suggestion).toBe("resolve the symlink first");
  });

  test("keeps the finding's own file and line when the residual omits them (AC-7)", () => {
    const { open } = absorbReReviewVerdict(
      [finding({ file: "b.ts", line: 9 })],
      verdictWith({ issue: "still bypass" }),
    );
    expect(open[0]?.file).toBe("b.ts");
    expect(open[0]?.line).toBe(9);
  });

  test("takes the residual's file and line when it gives them", () => {
    const { open } = absorbReReviewVerdict(
      [finding({ file: "old.ts", line: 1 })],
      verdictWith({ issue: "smaller problem", file: "new.ts", line: 42 }),
    );
    expect(open[0]?.file).toBe("new.ts");
    expect(open[0]?.line).toBe(42);
  });

  test("the open finding carries no observed key (AC-8)", () => {
    const { open } = absorbReReviewVerdict([finding()], verdictWith({ issue: "still bypass" }));
    expect(open[0]).not.toHaveProperty("observed");
  });

  test("a PARTIAL with no residual keeps the finding open unchanged (AC-2)", () => {
    const asked = finding();
    const { open } = absorbReReviewVerdict([asked], verdictWith(undefined));
    expect(open).toEqual([asked]);
  });
});

describe("absorbReReviewVerdict — addressed findings (US-004)", () => {
  test("a NOT_ADDRESSED finding stays open unchanged (AC-9)", () => {
    const asked = finding();
    const { open } = absorbReReviewVerdict([asked], verdictWith(undefined, { addressed: false }));
    expect(open).toEqual([asked]);
  });

  test("an ADDRESSED finding is dropped from open (AC-10)", () => {
    const { open } = absorbReReviewVerdict([finding()], verdictWith(undefined, { addressed: true }));
    expect(open).toEqual([]);
  });

  test("a PARTIAL verdict is never treated as addressed (AC-5)", () => {
    const { open } = absorbReReviewVerdict([finding()], verdictWith({ issue: "residual" }, { addressed: false }));
    expect(open.map((f) => f.id)).toEqual(["B1"]);
  });

  test("an asked finding with no verdict entry stays open", () => {
    const asked = [finding({ id: "B1" }), finding({ id: "B2" }), finding({ id: "B3" })];
    const { open } = absorbReReviewVerdict(asked, {
      verdicts: [{ id: "B3", addressed: true, note: "" }],
      newFindings: [],
    });
    expect(open.map((f) => f.id)).toEqual(["B1", "B2"]);
  });

  test("open keeps the asked order, whatever the verdict order", () => {
    const asked = [finding({ id: "B1" }), finding({ id: "B2" }), finding({ id: "B3" })];
    const verdict: ReReviewVerdict = {
      verdicts: [
        { id: "B3", addressed: true, note: "" },
        { id: "B2", addressed: false, note: "" },
        { id: "B1", addressed: false, note: "", residual: { issue: "residual of B1" } },
      ],
      newFindings: [],
    };
    const { open } = absorbReReviewVerdict(asked, verdict);
    expect(open.map((f) => f.id)).toEqual(["B1", "B2"]);
    expect(open[0]?.issue).toBe("residual of B1");
  });
});

describe("absorbReReviewVerdict — dropping a restated residual (US-004)", () => {
  test("drops a new finding at the residual's file and line (AC-11)", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: "a.ts", line: 53 })],
      verdictWith(
        { issue: "symlinks still bypass", file: "a.ts", line: 53 },
        { newFindings: [draft("same thing", "a.ts", 53)] },
      ),
    );
    expect(newDrafts).toEqual([]);
  });

  test("keeps a new finding at another line (AC-12)", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: "a.ts", line: 53 })],
      verdictWith(
        { issue: "symlinks still bypass", file: "a.ts", line: 53 },
        { newFindings: [draft("different", "a.ts", 60)] },
      ),
    );
    expect(newDrafts.map((d) => d.issue)).toEqual(["different"]);
  });

  test("falls back to the finding's file and line when the residual omits them (AC-13)", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: "b.ts", line: 9 })],
      verdictWith({ issue: "still open" }, { newFindings: [draft("restated", "b.ts", 9)] }),
    );
    expect(newDrafts).toEqual([]);
  });

  test("drops nothing when the residual and the finding both lack a file (AC-14)", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: undefined, line: undefined })],
      verdictWith(
        { issue: "still open" },
        { newFindings: [draft("restated", "b.ts", 9), draft("no location at all")] },
      ),
    );
    expect(newDrafts.map((d) => d.issue)).toEqual(["restated", "no location at all"]);
  });

  test("drops nothing when the residual has a file but no line", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: undefined, line: undefined })],
      verdictWith({ issue: "still open", file: "a.ts" }, { newFindings: [draft("restated", "a.ts", 9)] }),
    );
    expect(newDrafts.map((d) => d.issue)).toEqual(["restated"]);
  });

  test("keeps a new finding with no location next to a dropped one", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: "a.ts", line: 53 })],
      verdictWith(
        { issue: "symlinks still bypass", file: "a.ts", line: 53 },
        { newFindings: [draft("restated", "a.ts", 53), draft("broke parse", "src/p.ts", 7), draft("no location")] },
      ),
    );
    expect(newDrafts.map((d) => d.issue)).toEqual(["broke parse", "no location"]);
  });

  test("a finding whose verdict is ADDRESSED drops no new finding", () => {
    const { newDrafts } = absorbReReviewVerdict(
      [finding({ file: "a.ts", line: 53 })],
      verdictWith(undefined, { addressed: true, newFindings: [draft("new", "a.ts", 53)] }),
    );
    expect(newDrafts.map((d) => d.issue)).toEqual(["new"]);
  });
});
