import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import type { AdviceQuestion } from "@/advisor";
import { advisorConfigSelector } from "@/config";
import { adviseBatchOp } from "@/operations";

const q = (id: string): AdviceQuestion => ({
  id,
  kind: "residual",
  feature: "f",
  storyId: "US-3",
  askedAtSha: "abc",
  summary: id,
  evidence: [],
  options: [
    { id: "A", type: "waive", label: "w" },
    { id: "B", type: "hold", label: "h" },
  ],
});
const input = {
  kind: "residual" as const,
  summary: "s",
  items: [q("Q-1"), q("Q-2"), q("Q-3")],
  redGates: ["lint"],
  storyIds: [],
  specPath: "spec.md",
  prdText: "{}",
  priorDecisions: [],
};
const ctx = (() => {
  const config = makeNaxConfig({});
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(advisorConfigSelector)) };
})();
const ok = { rationale: "r", confidence: "high", reversible: true, needsHumanConfirm: false };

describe("adviseBatchOp.parse", () => {
  test("validates each answer on its own (Review Focus 1)", () => {
    const out = adviseBatchOp.parse(
      JSON.stringify({
        answers: [
          { itemId: "Q-1", optionId: "A", reason: "spec 3.2 allows it", ...ok },
          { itemId: "Q-2", optionId: "Z", ...ok },
        ],
        diagnoses: { lint: "biome config drift" },
      }),
      input,
      ctx,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.answers.map((a) => [a.itemId, a.reply?.optionId ?? null, a.error ?? null])).toEqual([
      ["Q-1", "A", null],
      ["Q-2", null, "optionId Z is not on the menu"],
      ["Q-3", null, "no answer for this item"],
    ]);
    expect(out.diagnoses).toEqual({ lint: "biome config drift" });
  });

  test("no JSON at all -> ok:false", () => {
    expect(adviseBatchOp.parse("I think we should hold.", input, ctx).ok).toBe(false);
  });

  test("preflight: keeps well-formed conflicts and the overlap table, drops unusable ones", () => {
    const out = adviseBatchOp.parse(
      JSON.stringify({
        overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
        conflicts: [
          {
            storyIds: ["US-2"],
            acRef: { storyId: "US-2", acId: "AC-3" },
            specSection: "4.1",
            description: "AC-3 says 30d, spec says 14d",
            optionId: "B",
            newText: "14 days",
            ...ok,
          },
          { storyIds: ["US-2"], description: "no refs" },
          { storyIds: ["US-2"], specSection: "4.1" },
        ],
      }),
      { ...input, kind: "preflight", items: [], redGates: [], storyIds: ["US-1", "US-2"] },
      ctx,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.overlap).toEqual([{ storyId: "US-1", specSections: ["3.2"] }]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.description).toBe("AC-3 says 30d, spec says 14d");
  });

  test("residual: no valid answer for any item -> ok:false no-valid-answers with a preview (#2554)", () => {
    const raw = JSON.stringify({ answers: [{ itemId: "Q-1", optionId: "Z", ...ok }] });
    const out = adviseBatchOp.parse(raw, input, ctx);
    expect(out).toEqual({ ok: false, error: "no-valid-answers", preview: expect.stringContaining("Q-1") });
  });

  test("residual: an empty JSON object -> ok:false no-valid-answers (#2554)", () => {
    const out = adviseBatchOp.parse("{}", input, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("no-valid-answers");
  });

  test("preflight: conflicts that is not an array -> ok:false (#2554)", () => {
    const pf = { ...input, kind: "preflight" as const, items: [], redGates: [], storyIds: ["US-1"] };
    for (const body of ["{}", JSON.stringify({ conflicts: "none" }), JSON.stringify({ overlap: [] })]) {
      const out = adviseBatchOp.parse(body, pf, ctx);
      expect(out.ok).toBe(false);
    }
  });

  test("preflight: an explicit empty conflicts array is a valid 'no conflicts' answer (#2554)", () => {
    const pf = { ...input, kind: "preflight" as const, items: [], redGates: [], storyIds: ["US-1"] };
    expect(adviseBatchOp.parse(JSON.stringify({ conflicts: [], overlap: [] }), pf, ctx).ok).toBe(true);
  });

  test("shape: fresh advisor session, read-only tools", () => {
    expect(adviseBatchOp.session).toEqual({ role: "advisor", lifetime: "fresh" });
    expect(adviseBatchOp.tools).toEqual(["Read", "Glob", "Grep"]);
  });
});
