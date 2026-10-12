import { describe, expect, test } from "bun:test";
import type { Finding } from "@/finish";
import { applyLedgerEvent, findingId, type LedgerEntry, type LedgerEvent, openFindings } from "@/finish/ledger";
import { createFinishState, deserializeFinishState, serializeFinishState } from "@/finish/state";

const f = (title: string): Finding => ({
  severity: "MEDIUM",
  title,
  problem: "p",
  fix: "x",
  file: "src/a.ts",
  source: "quality",
});
const apply = (events: LedgerEvent[]): LedgerEntry[] =>
  events.reduce<LedgerEntry[]>((acc, ev) => applyLedgerEvent(acc, ev), []);

describe("finish ledger (finish A §5)", () => {
  test("raised findings are open", () => {
    expect(apply([{ kind: "raised", findings: [f("A")] }])).toEqual([
      { id: findingId(f("A")), finding: f("A"), state: "open" },
    ]);
  });

  test("committed fix: fixed -> fixed-unreviewed(sha); rejected -> rejected(evidence)", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B")] },
      {
        kind: "fixed",
        findings: [f("A"), f("B")],
        dispositions: [
          { index: 1, disposition: "fixed" },
          { index: 2, disposition: "rejected", evidence: "src/a.ts:3" },
        ],
        sha: "abc",
      },
    ]);
    expect(l.map((e) => [e.finding.title, e.state, e.ref])).toEqual([
      ["A", "fixed-unreviewed", "abc"],
      ["B", "rejected", "src/a.ts:3"],
    ]);
  });

  test("missing disposition stays open", () => {
    const l = apply([
      { kind: "raised", findings: [f("A")] },
      { kind: "fixed", findings: [f("A")], dispositions: [], sha: "abc" },
    ]);
    expect(l[0]?.state).toBe("open");
  });

  test("a full round that does not re-raise a fixed finding marks it fixed-reviewed; re-raising reopens", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B")] },
      {
        kind: "fixed",
        findings: [f("A"), f("B")],
        dispositions: [
          { index: 1, disposition: "fixed" },
          { index: 2, disposition: "fixed" },
        ],
        sha: "s1",
      },
      { kind: "raised", findings: [f("B")] },
      { kind: "full-round", raised: [f("B")] },
    ]);
    expect(l.map((e) => [e.finding.title, e.state])).toEqual([
      ["A", "fixed-reviewed"],
      ["B", "open"],
    ]);
  });

  test("waived stays waived when re-raised; set-aside and unresolved count as open", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B"), f("C")] },
      { kind: "ruled", finding: f("A"), state: "waived", ref: "D-1" },
      { kind: "set-aside", findings: [f("B")], handoff: "handoff-1" },
      { kind: "ruled", finding: f("C"), state: "unresolved" },
      { kind: "raised", findings: [f("A")] },
    ]);
    expect(l[0]).toMatchObject({ state: "waived", ref: "D-1" });
    expect(openFindings(l).map((x) => x.title)).toEqual(["B", "C"]);
  });

  test("the round-cap path and the deadline path give identical states for the same events", () => {
    const events: LedgerEvent[] = [
      { kind: "raised", findings: [f("A")] },
      { kind: "fixed", findings: [f("A")], dispositions: [{ index: 1, disposition: "fixed" }], sha: "s" },
    ];
    expect(apply(events)).toEqual(apply([...events]));
    expect(openFindings(apply(events))).toEqual([]);
  });

  test("accepted residue is recorded and never mutates its input", () => {
    const l0 = apply([{ kind: "raised", findings: [f("A")] }]);
    const copy = structuredClone(l0);
    const l1 = applyLedgerEvent(l0, { kind: "accepted", findings: [f("A")], ref: "advisor approval" });
    expect(l1[0]).toMatchObject({ state: "accepted", ref: "advisor approval" });
    expect(l0).toEqual(copy);
  });

  test("ids are case-folded and differ by file or title", () => {
    const base = { severity: "LOW" as const, problem: "p", fix: "x" };
    const a: Finding = { ...base, source: "spec", title: "T", file: "f" };
    const b: Finding = { ...base, source: "spec", title: "t", file: "F" };
    expect(findingId(a)).toBe("spec|t|f");
    expect(findingId(a)).toBe(findingId(b));
    expect(findingId({ ...a, file: "g" })).not.toBe(findingId(a));
    expect(findingId({ ...a, title: "U" })).not.toBe(findingId(a));
    expect(findingId({ ...a, source: "quality" })).not.toBe(findingId(a));
  });

  test("a finding re-raised in later rounds keeps one entry, whatever its wording", () => {
    const l = apply([
      { kind: "raised", findings: [f("A")] },
      { kind: "raised", findings: [{ ...f("A"), problem: "reworded" }, f("B")] },
      { kind: "raised", findings: [f("A")] },
    ]);
    expect(l).toHaveLength(2);
    expect(l.map((e) => e.id)).toEqual([findingId(f("A")), findingId(f("B"))]);
  });

  test("a later unresolved ruling never overwrites a waived or superseded entry", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B")] },
      { kind: "ruled", finding: f("A"), state: "waived", ref: "D-1" },
      { kind: "ruled", finding: f("B"), state: "superseded", ref: "D-2" },
      { kind: "ruled", finding: f("A"), state: "unresolved" },
      { kind: "ruled", finding: f("B"), state: "unresolved" },
    ]);
    expect(l.map((e) => [e.state, e.ref])).toEqual([
      ["waived", "D-1"],
      ["superseded", "D-2"],
    ]);
  });

  test("a populated ledger survives serialize and deserialize with every field", () => {
    const state = createFinishState({
      feature: "f",
      workdir: "/w",
      branch: "b",
      runId: "r",
      base: "main",
      specPath: "s.md",
    });
    const ledger = apply([
      { kind: "raised", findings: [f("A"), f("B"), f("C")] },
      {
        kind: "fixed",
        findings: [f("A"), f("B")],
        dispositions: [
          { index: 1, disposition: "fixed" },
          { index: 2, disposition: "rejected", evidence: "src/a.ts:3" },
        ],
        sha: "abc",
      },
      { kind: "ruled", finding: f("C"), state: "waived", ref: "D-1" },
    ]);
    const round = deserializeFinishState(serializeFinishState({ ...state, review: { ...state.review, ledger } }));
    expect(round.review.ledger).toEqual(ledger);
    expect(round.review.ledger.map((e) => [e.state, e.ref])).toEqual([
      ["fixed-unreviewed", "abc"],
      ["rejected", "src/a.ts:3"],
      ["waived", "D-1"],
    ]);
  });
});
