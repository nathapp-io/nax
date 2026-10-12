import { describe, expect, test } from "bun:test";
import { assertDefined, makeAdviceDecision } from "@test/helpers";
import type { Finding, MergedFindings } from "@/finish";
import { checkRulings, matchLevel, rulingFromDecision, rulingFromDropped, splitForRulings } from "@/finish";

const f = (over: Partial<Finding> = {}): Finding => ({
  severity: "MEDIUM",
  title: "Exec argv loses its config refusal",
  problem: "p",
  fix: "x",
  source: "quality",
  file: "nax-agent/src/tools/package-managers.ts",
  ...over,
});

const waive = (over: Parameters<typeof makeAdviceDecision>[0] = {}) =>
  makeAdviceDecision({
    id: "D-1",
    kind: "finish-judgment",
    action: { type: "waive", reason: "PRD outOfScope names it" },
    dedupeKey: "quality|Exec argv loses its config refusal|nax-agent/src/tools/package-managers.ts",
    findingSeverity: "MEDIUM",
    ...over,
  });

describe("rulingFromDecision", () => {
  test("reads anchor and title from the decision fields first", () => {
    const r = rulingFromDecision(waive({ anchorFile: "a.ts", rulingTitle: "T" }));
    assertDefined(r, "ruling");
    expect(r).toMatchObject({ id: "D-1", action: "waive", anchor: "a.ts", title: "T", blocking: false });
    expect(r.summary).toBe("waive: T (a.ts) — PRD outOfScope names it");
    expect(r.decision?.id).toBe("D-1");
  });

  test("legacy line: anchor and title recovered from the dedupe key", () => {
    const r = rulingFromDecision(waive());
    assertDefined(r, "ruling");
    expect(r.anchor).toBe("nax-agent/src/tools/package-managers.ts");
    expect(r.title).toBe("Exec argv loses its config refusal");
  });

  test("legacy line ending in a #hash has no anchor (Review Focus 2)", () => {
    const r = rulingFromDecision(waive({ dedupeKey: "spec|Generic|#abc123def456" }));
    assertDefined(r, "ruling");
    expect(r.anchor).toBeUndefined();
    expect(matchLevel(f({ title: "Generic" }), r)).toBe("none");
  });

  test("a title containing | splits on the first and last separator", () => {
    const r = rulingFromDecision(waive({ dedupeKey: "quality|a | b|src/x.ts" }));
    assertDefined(r, "ruling");
    expect(r.title).toBe("a | b");
    expect(r.anchor).toBe("src/x.ts");
  });

  test("only finish-judgment waive / supersede decisions are rulings", () => {
    expect(rulingFromDecision(waive({ action: { type: "fix", instruction: "i" } }))).toBeUndefined();
    expect(rulingFromDecision(waive({ kind: "fix-cycle-give-up" }))).toBeUndefined();
  });

  test("a HIGH ruling is blocking", () => {
    expect(rulingFromDecision(waive({ findingSeverity: "HIGH" }))?.blocking).toBe(true);
  });
});

describe("matchLevel", () => {
  const r = rulingFromDecision(waive());
  assertDefined(r, "ruling");
  test("#2464: a re-titled finding on the same file is near, from either lens", () => {
    const retitled = f({ title: "Opening configRefusal also unscreens Exec/install argv paths" });
    expect(matchLevel(retitled, r)).toBe("near");
    expect(matchLevel({ ...retitled, source: "spec" }, r)).toBe("near");
  });
  test("same file and same normalised title is exact, whatever the lens", () => {
    expect(matchLevel(f({ title: "exec ARGV loses its  config refusal.", source: "spec" }), r)).toBe("exact");
  });
  test("a different file is none; a finding without a file is none", () => {
    expect(matchLevel(f({ file: "other.ts" }), r)).toBe("none");
    expect(matchLevel(f({ file: undefined, problem: "no path here" }), r)).toBe("none");
  });
  test("legacy key equality is exact even without an anchor", () => {
    const hashKeyed = rulingFromDecision(waive({ dedupeKey: "quality|Generic|#000000000000" }));
    assertDefined(hashKeyed, "r");
    const legacy = { ...hashKeyed, legacyKey: "quality|Generic|src/z.ts" };
    expect(matchLevel(f({ title: "Generic", file: undefined, problem: "see src/z.ts:3" }), legacy)).toBe("exact");
  });
});

describe("checkRulings", () => {
  test("exact non-blocking match is reused; near is asked; no match is rest", () => {
    const r = rulingFromDecision(waive());
    assertDefined(r, "ruling");
    const exact = f({ source: "spec" });
    const near = f({ title: "Other wording" });
    const free = f({ file: "free.ts" });
    const out = checkRulings([exact, near, free], [r]);
    expect(out.reuse).toEqual([{ finding: exact, ruling: r }]);
    expect(out.near).toEqual([{ finding: near, rulings: [r] }]);
    expect(out.rest).toEqual([free]);
  });

  test("a blocking finding or ruling is never reused: it becomes near", () => {
    const r = rulingFromDecision(waive());
    assertDefined(r, "ruling");
    expect(checkRulings([f({ severity: "HIGH" })], [r]).near).toHaveLength(1);
    const blocking = { ...r, blocking: true };
    expect(checkRulings([f()], [blocking]).near).toHaveLength(1);
  });

  test("near collects every matching ruling, newest first (Review Focus 1)", () => {
    const d1 = rulingFromDecision(waive({ id: "D-1" }));
    assertDefined(d1, "d1");
    const d2 = rulingFromDecision(
      waive({ id: "D-2", action: { type: "supersede", target: { kind: "spec", section: "4" }, newText: "n" } }),
    );
    assertDefined(d2, "d2");
    const out = checkRulings([f({ title: "Third finding" })], [d1, d2]);
    expect(out.near[0]?.rulings.map((x) => x.id)).toEqual(["D-2", "D-1"]);
  });
});

describe("rulingFromDropped", () => {
  test("a same-round waive binds by the finding's file and title", () => {
    const finding = f({ title: "ThreadJobRun has two lifetimes", source: "spec", file: "src/thread-job-run.ts" });
    const r = rulingFromDropped({ finding, decisionId: "D-2", action: "waive" });
    expect(r).toMatchObject({ id: "D-2", action: "waive", anchor: "src/thread-job-run.ts", blocking: false });
    expect(r.decision).toBeUndefined();
  });

  test("with the same-round decision, the summary carries its reason and the decision is attached", () => {
    const finding = f({ file: "src/t.ts", title: "Seam" });
    const d = waive({ id: "D-2", action: { type: "waive", reason: "acceptance drives runs through it" } });
    const r = rulingFromDropped({ finding, decisionId: "D-2", action: "waive" }, d);
    expect(r.summary).toBe("waive: Seam (src/t.ts) — acceptance drives runs through it");
    expect(r.decision?.id).toBe("D-2");
  });
});

describe("splitForRulings", () => {
  test("no rulings: merged is returned unchanged", () => {
    const merged: MergedFindings = { toFix: [f()], judged: [], contradictions: [] };
    expect(splitForRulings(merged, []).merged).toBe(merged);
  });

  test("a contradiction with a ruled side is dissolved; the free side goes to toFix", () => {
    const r = rulingFromDecision(waive());
    assertDefined(r, "ruling");
    const spec = f({ source: "spec", title: "Spec side", file: "nax-agent/src/tools/package-managers.ts" });
    const quality = f({ source: "quality", title: "Quality side", file: "nax-agent/src/tools/package-managers.ts" });
    // both sides near-match the same-file ruling, so both are handled through the check
    const out = splitForRulings({ toFix: [], judged: [], contradictions: [{ spec, quality }] }, [r]);
    expect(out.merged.contradictions).toEqual([]);
    expect(out.check.near.map((n) => n.finding)).toEqual([spec, quality]);
    expect(out.merged.toFix).toEqual([]);
  });

  test("only matched findings leave toFix and judged", () => {
    const r = rulingFromDecision(waive());
    assertDefined(r, "ruling");
    const matched = f({ title: "Other wording" });
    const free = f({ file: "free.ts" });
    const judgedFree = f({ file: "j.ts", judgment: true });
    const out = splitForRulings({ toFix: [matched, free], judged: [judgedFree], contradictions: [] }, [r]);
    expect(out.merged.toFix).toEqual([free]);
    expect(out.merged.judged).toEqual([judgedFree]);
  });
});
