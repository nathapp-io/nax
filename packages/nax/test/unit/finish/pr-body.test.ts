/**
 * `buildAdvisorSection` — the one part of the finish PR body that survived the
 * finish-machine deletion.
 *
 * Everything else `src/finish/pr/body.ts` used to render went with the machine.
 * This renderer stayed because the workflow PR body still calls it
 * (`src/workflow/pr-body.ts`), so the three behaviours a reader of an
 * `## Advisor decisions` section depends on are pinned here: the decisions a
 * human must confirm come first, free text from the advisor cannot inject
 * structure into the body, and every supersede is repeated as an amendment the
 * reader has to apply.
 */
import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { AdviceAction, AdviceDecision } from "@/advisor";
import { buildAdvisorSection } from "@/finish";

/** One line of the rendered section, so an assertion cannot match the wrong decision. */
function lineOf(section: string, id: string): string {
  const line = section.split("\n").find((l) => l.startsWith(`- **${id}**`));
  if (line === undefined) throw new Error(`no line for ${id} in:\n${section}`);
  return line;
}

function decide(id: string, action: AdviceAction, over: Partial<AdviceDecision> = {}): AdviceDecision {
  return makeAdviceDecision({ id, storyId: "US-2", action, ...over });
}

describe("buildAdvisorSection — absent when the advisor made no decisions", () => {
  test("returns null for no decisions and for an empty list", () => {
    expect(buildAdvisorSection(undefined)).toBeNull();
    expect(buildAdvisorSection([])).toBeNull();
  });
});

describe("buildAdvisorSection — flagged decisions come first (A1)", () => {
  const decisions: AdviceDecision[] = [
    decide("D-1", { type: "fix", instruction: "x" }),
    decide(
      "D-2",
      { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "returns 0" },
      {
        needsHumanConfirm: true,
      },
    ),
    decide("D-3", { type: "answer", text: "Use Postgres" }),
  ];

  test("a decision that needs confirmation is rendered above one that does not", () => {
    const section = buildAdvisorSection(decisions) ?? "";
    expect(section).not.toBe("");
    expect(section.indexOf("**D-2**")).toBeLessThan(section.indexOf("**D-1**"));
  });

  test("each group keeps the order the advisor wrote", () => {
    const section = buildAdvisorSection(decisions) ?? "";
    // Both unflagged decisions stay in input order below the flagged one.
    expect(section.indexOf("**D-1**")).toBeLessThan(section.indexOf("**D-3**"));
  });

  test("only the flagged line is marked as needing confirmation", () => {
    const section = buildAdvisorSection(decisions) ?? "";
    expect(lineOf(section, "D-2")).toContain("(needs confirmation)");
    expect(lineOf(section, "D-1")).not.toContain("(needs confirmation)");
    expect(lineOf(section, "D-3")).not.toContain("(needs confirmation)");
  });
});

describe("buildAdvisorSection — free text cannot break the body", () => {
  test("newlines collapse, so a rationale cannot inject a heading", () => {
    const section =
      buildAdvisorSection([
        decide("D-1", { type: "hold", reason: "r" }, { rationale: "line1\n## Injected heading" }),
      ]) ?? "";
    expect(section).not.toContain("\n## Injected heading");
    expect(lineOf(section, "D-1")).toContain("line1 ## Injected heading");
  });

  test("HTML is stripped from the rationale", () => {
    const section =
      buildAdvisorSection([
        decide("D-1", { type: "hold", reason: "r" }, { rationale: "keep <img src=x onerror=1>" }),
      ]) ?? "";
    expect(section).not.toContain("<img");
    expect(lineOf(section, "D-1")).toContain("keep");
  });

  test("an over-long rationale is capped, so one decision cannot fill the body", () => {
    const section = buildAdvisorSection([decide("D-1", { type: "hold", reason: "r" }, { rationale: "z".repeat(600) })])
      ?.split("\n")
      .find((l) => l.startsWith("- **D-1**"));
    expect(section).toBeDefined();
    // The cap is 300 characters plus the ellipsis that marks the truncation.
    expect(section?.endsWith("…")).toBe(true);
    expect(section?.length).toBeLessThan(330);
    expect(section).not.toContain("z".repeat(301));
  });
});

describe("buildAdvisorSection — what each ruling says", () => {
  test("a carry names its target stories and its instruction", () => {
    const section =
      buildAdvisorSection([
        decide("D-1", { type: "carry", instruction: "Keep lock order", toStories: ["US-4", "US-5"] }),
      ]) ?? "";
    expect(lineOf(section, "D-1")).toContain("carry → US-4, US-5 — Keep lock order");
  });

  test("an answer renders the text it ruled", () => {
    const section = buildAdvisorSection([decide("D-1", { type: "answer", text: "Use Postgres" })]) ?? "";
    expect(lineOf(section, "D-1")).toContain("answer — Use Postgres");
  });

  test("every other action renders its type and its rationale", () => {
    const section = buildAdvisorSection([decide("D-1", { type: "approve" }, { rationale: "gates green" })]) ?? "";
    expect(lineOf(section, "D-1")).toContain("approve — gates green");
  });

  test("a ruling that lets acceptance tests change says which ones", () => {
    const section =
      buildAdvisorSection([
        decide(
          "D-3",
          { type: "fix", instruction: "i", updateAcs: ["AC-40"] },
          { acceptanceChanges: ["AC-40", "AC-51"] },
        ),
      ]) ?? "";
    expect(lineOf(section, "D-3")).toContain("— acceptance tests changed: AC-40, AC-51");
  });

  test("a decision with no story is attributed to the feature", () => {
    const section = buildAdvisorSection([decide("D-1", { type: "approve" }, { storyId: undefined })]) ?? "";
    expect(lineOf(section, "D-1")).toContain("feature");
  });
});

describe("buildAdvisorSection — supersedes are repeated as amendments to apply (A1)", () => {
  test("an AC supersede names the target, the new text and the decision", () => {
    const section =
      buildAdvisorSection([
        decide("D-2", {
          type: "supersede",
          target: { kind: "ac", storyId: "US-2", acId: "AC-3" },
          newText: "returns 0",
        }),
      ]) ?? "";
    expect(section).toContain("### Spec amendments to apply");
    expect(section).toContain("- US-2 AC-3: returns 0 (D-2)");
  });

  test("a spec supersede names the section", () => {
    const section =
      buildAdvisorSection([
        decide("D-4", { type: "supersede", target: { kind: "spec", section: "2.1 Scope" }, newText: "in scope" }),
      ]) ?? "";
    expect(section).toContain("- spec § 2.1 Scope: in scope (D-4)");
  });

  test("the amendment appears below the decision list, which also keeps the decision", () => {
    const section =
      buildAdvisorSection([
        decide("D-1", { type: "approve" }),
        decide("D-2", {
          type: "supersede",
          target: { kind: "ac", storyId: "US-2", acId: "AC-3" },
          newText: "returns 0",
        }),
      ]) ?? "";
    expect(section.indexOf("**D-2**")).toBeLessThan(section.indexOf("### Spec amendments to apply"));
    expect(lineOf(section, "D-2")).toContain("supersede");
  });

  test("no amendment block when no decision supersedes anything", () => {
    const section = buildAdvisorSection([decide("D-1", { type: "approve" })]) ?? "";
    expect(section).not.toContain("Spec amendments to apply");
  });
});
