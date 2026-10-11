import { describe, expect, test } from "bun:test";
import { mergeFindings } from "@/finish/merge-findings";
import type { Finding } from "@/finish/types";

const f = (o: Partial<Finding>): Finding => ({ severity: "LOW", title: "t", problem: "p", fix: "x", ...o });

describe("mergeFindings", () => {
  test("collapses exact duplicates across lenses, keeping the higher severity", () => {
    const out = mergeFindings(
      [f({ title: "Leak", file: "a.ts", line: 3, severity: "LOW", source: "spec" })],
      [f({ title: " leak ", file: "a.ts", line: 3, severity: "HIGH", source: "quality" })],
    );
    expect(out.toFix).toHaveLength(1);
    expect(out.toFix[0]?.severity).toBe("HIGH");
    expect(out.contradictions).toEqual([]);
  });

  test("same file and line, different titles, different lenses = contradiction, not fixed", () => {
    const s = f({ title: "Must retry", file: "a.ts", line: 9, source: "spec" });
    const q = f({ title: "Retry loop is bad design", file: "a.ts", line: 9, source: "quality" });
    const out = mergeFindings([s], [q]);
    expect(out.toFix).toEqual([]);
    expect(out.contradictions).toEqual([{ spec: s, quality: q }]);
  });

  test("findings without a file are never contradictions", () => {
    const out = mergeFindings([f({ title: "A", source: "spec" })], [f({ title: "B", source: "quality" })]);
    expect(out.contradictions).toEqual([]);
    expect(out.toFix.map((x) => x.title)).toEqual(["A", "B"]);
  });

  test("judgment findings are routed to judged, never to toFix or contradictions", () => {
    const j = f({ title: "J", file: "a.ts", line: 1, judgment: true, source: "spec" });
    const q = f({ title: "Q", file: "a.ts", line: 1, source: "quality" });
    const out = mergeFindings([j], [q]);
    expect(out.judged).toEqual([j]);
    expect(out.toFix).toEqual([q]);
    expect(out.contradictions).toEqual([]);
  });

  test("toFix is spec first, then quality", () => {
    const out = mergeFindings(
      [f({ title: "S", file: "s.ts", source: "spec" })],
      [f({ title: "Q", file: "q.ts", source: "quality" })],
    );
    expect(out.toFix.map((x) => x.source)).toEqual(["spec", "quality"]);
  });

  test("one spec finding pairs with at most one quality finding", () => {
    const s = f({ title: "S", file: "a.ts", line: 2, source: "spec" });
    const q1 = f({ title: "Q1", file: "a.ts", line: 2, source: "quality" });
    const q2 = f({ title: "Q2", file: "a.ts", line: 2, source: "quality" });
    const out = mergeFindings([s], [q1, q2]);
    expect(out.contradictions).toEqual([{ spec: s, quality: q1 }]);
    expect(out.toFix).toEqual([q2]);
  });
});
