import { describe, expect, test } from "bun:test";
import type { Finding } from "@/finish";
import { applyLedgerEvent, findingId, type LedgerEntry, type LedgerEvent, openFindings } from "@/finish/ledger";

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
});
