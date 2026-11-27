import { describe, expect, test } from "bun:test";
import type { BotPrReviewPromptInput } from "@/prompts";
import * as prompts from "@/prompts";

const base: BotPrReviewPromptInput = {
  packagePath: "/p.diff",
  range: "m..HEAD",
  staticMode: false,
  pr: { number: 42, title: "Title", body: "Adds X", author: "alice" },
  issues: [],
  threads: [],
  comments: [],
};

function taskLines(input: BotPrReviewPromptInput): string[] {
  const prompt = prompts.buildBotPrReviewPrompt(input);
  return prompt.slice(prompt.lastIndexOf("## Your task")).split("\n");
}

const OFF =
  "off-contract: needs a caller, subclass or configuration value that breaks a type, schema or documented contract of this repository.";
const SKEW = "version-skew: needs two versions of the product running together, or data written by an earlier version.";
const FAULT = "backend-fault: needs a store, network or clock failure between two steps of one operation.";
const EVIDENCE =
  'For normal, "triggerEvidence" names the document, configuration, example or test in this repository that shows that use. A document on the base branch that describes the behaviour itself as intended shows there is no finding. A test this pull request adds, changes or removes shows what the pull request does, not ordinary use.';

const NOT_A_FINDING =
  "Behaviour this pull request does not change is not a finding of this pull request when the base branch already has it or the spec lists it as out of scope, unless the pull request's description, a linked issue or the PRD says it fixes it.";
const SMALLEST_CHANGE =
  "A suggestion is the smallest change that removes the problem. When even the smallest change needs new public API, a new mechanism, or a change in another repository, the suggestion says so.";

describe("buildBotPrReviewPrompt trigger classes (bot-trigger-classes US-001)", () => {
  const lines = taskLines(base);
  test.each([
    ["AC-11", "off-contract:", OFF],
    ["AC-12", "version-skew:", SKEW],
    ["AC-13", "backend-fault:", FAULT],
  ])("%s defines %s on exactly one line", (_ac, prefix, definition) => {
    expect(lines.filter((l) => l.startsWith(prefix))).toEqual([definition]);
  });
  test("AC-14 the line after normal: states the normal evidence", () => {
    const at = lines.findIndex((l) => l.startsWith("normal:"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(EVIDENCE);
  });
  test("AC-15 the seven class lines appear in order", () => {
    const order = [
      "normal:",
      "off-contract:",
      "version-skew:",
      "backend-fault:",
      "own-concurrency:",
      "adversarial:",
      "manual:",
    ];
    const at = order.map((p) => lines.findIndex((l) => l.startsWith(p)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  test("AC-16 the finding shape names the seven classes", () => {
    expect(lines.join("\n")).toContain(
      '"trigger": "normal|off-contract|version-skew|backend-fault|own-concurrency|adversarial|manual", "triggerEvidence": "..."',
    );
  });
  test("AC-17 a conversation-only review gets the off-contract line", () => {
    expect(taskLines({ ...base, conversationOnly: true })).toContain(OFF);
  });
  test("#2987 every contract, conversation-only included, states what is not a finding and what a suggestion is", () => {
    for (const input of [base, { ...base, conversationOnly: true }]) {
      const task = taskLines(input);
      expect(task.filter((l) => l === NOT_A_FINDING)).toEqual([NOT_A_FINDING]);
      expect(task.filter((l) => l === SMALLEST_CHANGE)).toEqual([SMALLEST_CHANGE]);
    }
  });
  test("#2987 the two facts come before the class lines and the reply shape", () => {
    const task = taskLines(base);
    const at = (line: string) => task.indexOf(line);
    expect(at(NOT_A_FINDING)).toBeGreaterThan(task.findIndex((l) => l.startsWith("Severity:")));
    expect(at(SMALLEST_CHANGE)).toBeLessThan(task.findIndex((l) => l.startsWith("Name each finding's class")));
  });
});

describe("buildBotPrReviewPrompt normal evidence (#3069)", () => {
  const PR_TEST_LINE =
    "A test this pull request adds, changes or removes shows what the pull request does, not ordinary use.";
  test.each([
    ["a full review", base],
    ["an incremental review", { ...base, incrementalSince: "a".repeat(40), mergeBase: "b".repeat(40) }],
    ["a conversation-only review", { ...base, conversationOnly: true }],
  ])("says a pull request's own test is not ordinary use in %s", (_name, input) => {
    expect(taskLines(input).filter((line) => line.includes(PR_TEST_LINE))).toHaveLength(1);
  });
});
