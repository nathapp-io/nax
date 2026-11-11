/**
 * US-012 (branch-review-coverage): the prompt names the files a settled ruling already covered, so the
 * reviewer knows which paths it may skip. Empty credit renders nothing — the section exists only when
 * something was actually credited.
 */
import { describe, expect, test } from "bun:test";
import type { BotPrReviewPromptInput } from "@/prompts";
import { buildBotPrReviewPrompt } from "@/prompts";

const base: BotPrReviewPromptInput = {
  packagePath: "/p.diff",
  range: "m..HEAD",
  staticMode: false,
  pr: { number: 42, title: "Title", body: "Adds X", author: "alice" },
  issues: [],
  threads: [],
  comments: [],
};

const HEADING = "## Files covered by settled rulings";
const INSTRUCTION =
  "A collaborator verified these files at a commit they have not changed since. You do not need to read them. Read every other changed file in the package.";

describe("buildBotPrReviewPrompt: files covered by settled rulings", () => {
  test("AC-17 names the credit and tells the reviewer what it may skip", () => {
    const prompt = buildBotPrReviewPrompt({ ...base, coveredByRulings: ["a.ts"] });
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain("You do not need to read them. Read every other changed file in the package.");
    expect(prompt).toContain(`${INSTRUCTION}\n- a.ts`);
  });

  test("AC-18 renders no section when nothing was credited", () => {
    expect(buildBotPrReviewPrompt({ ...base, coveredByRulings: [] })).not.toContain(HEADING);
    expect(buildBotPrReviewPrompt(base)).not.toContain(HEADING);
  });
});
