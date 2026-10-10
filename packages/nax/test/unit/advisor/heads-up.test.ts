import { describe, expect, test } from "bun:test";
import { makeAdviceDecision, makeAdviceQuestion } from "@test/helpers";
import { AdvisorHeadsUpQueue, formatHeadsUp } from "@/advisor";

describe("heads-up", () => {
  test("names the feature, story, question, choice, rationale and id", () => {
    const q = makeAdviceQuestion({
      id: "Q-1",
      kind: "fix-cycle-give-up",
      feature: "feat",
      storyId: "US-2",
      summary: "AC1 vs finding",
      askedAtSha: "s",
      evidence: [],
      options: [],
    });
    const d = makeAdviceDecision({
      id: "D-4",
      kind: "fix-cycle-give-up",
      action: { type: "waive", reason: "US-5 owns it" },
      rationale: "scope",
      confidence: "low",
    });
    const text = formatHeadsUp(d, q);
    for (const s of ["feat", "US-2", "AC1 vs finding", "waive", "scope", "D-4", "low"]) expect(text).toContain(s);
  });

  test("queue drains per story and only once", () => {
    const q = new AdvisorHeadsUpQueue();
    q.push("US-1", "a");
    q.push("US-2", "b");
    q.push("US-1", "c");
    expect(q.drain("US-1")).toEqual(["a", "c"]);
    expect(q.drain("US-1")).toEqual([]);
    expect(q.drain("US-2")).toEqual(["b"]);
  });
});
