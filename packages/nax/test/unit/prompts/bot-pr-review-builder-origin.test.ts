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
const since = "a".repeat(40);
const push = {
  base: "b".repeat(40),
  sha: "c".repeat(40),
  at: "2026-01-01T00:00:00.000Z",
  items: [{ key: "f-a", generation: 1, issue: "lock leaks" }],
};

const originIntro = `Name each finding's origin with "origin" and the one detail that shows it with "originEvidence". The origins are:`;
const manualDefinition = "manual: needs a human acting on the checkout or state mid-operation.";
const originDefinitions = [
  "pr: the problem is in the pull request's own change.",
  'fix-regression: a push listed under "Earlier nax bot fix pushes in this range" broke behaviour that worked before that push.',
  'fix-gap: a further gap in code a push listed under "Earlier nax bot fix pushes in this range" added to close an earlier item, where the behaviour before that push was the same or worse.',
];
const originShape = '"triggerEvidence": "...", "origin": "pr|fix-regression|fix-gap", "originEvidence": "..."';
const PUSH_HEADING = "## Earlier nax bot fix pushes in this range";

/** Every prompt that lists in-range bot pushes, so every one of these renders the push section. */
const asked = prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: since, botPushes: [push] });
const taskOf = (prompt: string) => prompt.slice(prompt.lastIndexOf("## Your task"));
const askedTask = taskOf(asked);
const askedLines = askedTask.split("\n");

/** The intro's index, asserting it rendered exactly once. */
function originIntroAt(lines: readonly string[]): number {
  const matches = lines.filter((line) => line === originIntro);
  expect(matches).toHaveLength(1);
  return lines.indexOf(originIntro);
}

/**
 * Origin lines are asked for only when the prompt renders the push section. The control is the same
 * prompt with the one missing ingredient present, so a pass here is the condition at work, not a
 * prompt that could never ask.
 */
function expectsNoOriginRequest(prompt: string) {
  expect(prompt).not.toContain(PUSH_HEADING);
  expect(asked).toContain(PUSH_HEADING);
  const task = taskOf(prompt);
  expect(task.split("\n").filter((line) => line.startsWith("Name each finding's origin"))).toEqual([]);
  expect(task).not.toContain('"origin":');
  expect(askedTask).toContain(originIntro);
  expect(askedTask).toContain(originShape);
}

describe("buildBotPrReviewPrompt finding origin request (US-002)", () => {
  test("AC-5 asks for an origin directly after the manual class definition", () => {
    expect(askedLines[originIntroAt(askedLines) - 1]).toBe(manualDefinition);
  });
  test("AC-6 defines the three origins in order, immediately after the request", () => {
    const introAt = originIntroAt(askedLines);
    expect(askedLines.slice(introAt + 1, introAt + 4)).toEqual(originDefinitions);
  });
  test("AC-7 the finding shape carries origin and originEvidence after triggerEvidence", () => {
    expect(askedTask).toContain(originShape);
  });
  test("AC-8 an incremental review with no bot push is not asked for an origin", () => {
    expectsNoOriginRequest(prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: since, botPushes: [] }));
  });
  test("AC-9 a full review with bot pushes is not asked for an origin", () => {
    expectsNoOriginRequest(prompts.buildBotPrReviewPrompt({ ...base, botPushes: [push] }));
  });
  test("AC-10 a conversation-only review with bot pushes is not asked for an origin", () => {
    expectsNoOriginRequest(
      prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: since, botPushes: [push], conversationOnly: true }),
    );
  });
});
