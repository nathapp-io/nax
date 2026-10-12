import { describe, expect, test } from "bun:test";
import type { AdviceQuestion } from "@/advisor";
import { buildAdvisorBatchPrompt } from "@/prompts";

const item: AdviceQuestion = {
  id: "Q-1",
  kind: "residual",
  feature: "f",
  storyId: "US-3",
  askedAtSha: "abc",
  summary: "AC-2 untested",
  evidence: [{ source: "finding", ref: "F2", text: "AC-2 has no test" }],
  options: [
    { id: "A", type: "waive", label: "Park: the reviewer is wrong" },
    { id: "D", type: "hold", label: "Flag" },
  ],
};
const base = { specPath: "spec.md", prdText: "{}", priorDecisions: [] };

describe("buildAdvisorBatchPrompt", () => {
  test("residual: every item with its own menu, the gates to diagnose, and the answers contract", () => {
    const text = buildAdvisorBatchPrompt({
      ...base,
      kind: "residual",
      summary: "US-3 hit its cap",
      items: [item],
      redGates: ["full-suite"],
      storyIds: [],
    });
    for (const needle of [
      "Q-1",
      "AC-2 untested",
      "A. [waive]",
      "full-suite",
      '"answers"',
      '"itemId"',
      '"diagnoses"',
      "Decision policy",
    ]) {
      expect(text).toContain(needle);
    }
  });

  test("preflight: the four fixed options, the overlap table and the conflicts contract", () => {
    const text = buildAdvisorBatchPrompt({
      ...base,
      kind: "preflight",
      summary: "pre-flight",
      items: [],
      redGates: [],
      storyIds: ["US-1", "US-2"],
    });
    for (const needle of [
      '"overlap"',
      '"conflicts"',
      '"acRef"',
      '"specSection"',
      "A —",
      "B —",
      "C —",
      "D —",
      "US-1, US-2",
    ]) {
      expect(text).toContain(needle);
    }
  });
});
