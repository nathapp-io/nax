import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings/types";
import type { NbfWorthCheckPromptInput } from "@/prompts";
import { makeStory } from "@test/helpers";
import * as prompts from "@/prompts";

const findingA: Finding = {
  source: "adversarial-review",
  severity: "warning",
  category: "input",
  file: "src/a.ts",
  line: 12,
  message: "empty items still fires MARK_DELIVERING",
};
const findingB: Finding = {
  source: "adversarial-review",
  severity: "info",
  category: "convention",
  file: "src/b.ts",
  line: 3,
  message: "stale header comment",
};
const baseInput = {
  story: makeStory({
    id: "US-002",
    title: "Deliver orders",
    description: "d",
    acceptanceCriteria: ["AC one"],
    status: "in-progress",
    attempts: 1,
  }),
  diff: "+x",
  findings: [findingA, findingB],
  pendingStories: [],
};
const candidateBuilder: unknown = Reflect.get(prompts, "buildNbfWorthCheckPrompt");

function buildNbfWorthCheckPrompt(input: NbfWorthCheckPromptInput): string {
  return typeof candidateBuilder === "function" ? candidateBuilder(input) : "";
}

describe("buildNbfWorthCheckPrompt (US-001)", () => {
  test("US-001 AC1: renders the first finding with severity, category, and location", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain(
      "1. [warning/input] src/a.ts:12 — empty items still fires MARK_DELIVERING",
    );
  });

  test("US-001 AC2: renders the second finding with its one-based index", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain("2. [info/convention] src/b.ts:3 — stale header comment");
  });

  test("US-001 AC3: renders the story identifier and title", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain("US-002: Deliver orders");
  });

  test("US-001 AC4: renders each story acceptance criterion as a bullet", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain("- AC one");
  });

  test("US-001 AC5: places the diff after the Story diff heading", () => {
    const prompt = buildNbfWorthCheckPrompt(baseInput);
    expect(prompt.indexOf("+x")).toBeGreaterThan(prompt.indexOf("## Story diff"));
  });

  test("US-001 AC6: omits the pending-stories section when there are no pending stories", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).not.toContain("## Pending stories in this feature");
  });

  test("US-001 AC7: renders a pending story identifier and title", () => {
    const prompt = buildNbfWorthCheckPrompt({
      ...baseInput,
      pendingStories: [{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] }],
    });
    expect(prompt).toContain("US-003: Retry delivery");
  });

  test("US-001 AC8: renders pending-story acceptance criteria after the pending stories heading", () => {
    const prompt = buildNbfWorthCheckPrompt({
      ...baseInput,
      pendingStories: [{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] }],
    });
    expect(prompt.indexOf("- retries twice")).toBeGreaterThan(prompt.indexOf("## Pending stories in this feature"));
  });

  test("US-001 AC9: explains that an empty diff is unavailable", () => {
    expect(buildNbfWorthCheckPrompt({ ...baseInput, diff: "" })).toContain(
      "(diff unavailable — judge from the code)",
    );
  });

  test("US-001 AC10: omits the line number when a finding has no line", () => {
    expect(buildNbfWorthCheckPrompt({ ...baseInput, findings: [{ ...findingA, line: undefined }] })).toContain(
      "1. [warning/input] src/a.ts — empty items still fires MARK_DELIVERING",
    );
  });

  test("US-001 AC11: uses the no-file label when a finding has no file or line", () => {
    expect(
      buildNbfWorthCheckPrompt({ ...baseInput, findings: [{ ...findingA, file: undefined, line: undefined }] }),
    ).toContain("1. [warning/input] (no file) — empty items still fires MARK_DELIVERING");
  });

  test("US-001 AC12: renders an available suggested fix on the following line", () => {
    expect(buildNbfWorthCheckPrompt({ ...baseInput, findings: [{ ...findingA, suggestion: "use parser.error" }] })).toContain(
      "   Suggested fix: use parser.error",
    );
  });

  test('US-001 AC13: includes the rubric instruction to fix when unsure', () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain('When you are unsure, answer "fix".');
  });

  test("US-001 AC14: includes the exact JSON reply contract", () => {
    expect(buildNbfWorthCheckPrompt(baseInput)).toContain(
      '{"verdicts":[{"index":1,"verdict":"fix","reason":"<one line>"}]}',
    );
  });

  test("US-001 AC15: orders Story, diff, findings, rubric, and reply sections", () => {
    const prompt = buildNbfWorthCheckPrompt(baseInput);
    const headings = ["## Story", "## Story diff", "## Findings", "## How to judge", "## Reply"];
    const positions = headings.map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
