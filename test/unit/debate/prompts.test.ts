/**
 * Tests for debate prompt templates — US-002
 *
 * Covers:
 * - buildCritiquePrompt: each debater receives all other debaters' proposals (not their own)
 * - buildSynthesisPrompt: contains all proposals and critiques
 * - buildJudgePrompt: contains all proposals and critiques
 * - AC5 (prompt content): critique prompt from session.ts delegates to buildCritiquePrompt
 */

import { describe, expect, test } from "bun:test";
import { buildCritiquePrompt, buildJudgePrompt, buildSynthesisPrompt } from "../../../src/debate/prompts";

// ─── buildCritiquePrompt ─────────────────────────────────────────────────────

describe("buildCritiquePrompt()", () => {
  test("includes all other debaters' proposals in the critique prompt", () => {
    const allProposals = ["proposal from A", "proposal from B", "proposal from C"];

    // Debater at index 0 should see proposals from index 1 and 2
    const prompt = buildCritiquePrompt("task description", allProposals, 0);

    expect(prompt).toContain("proposal from B");
    expect(prompt).toContain("proposal from C");
  });

  test("does NOT include this debater's own proposal in the critique prompt", () => {
    const allProposals = ["proposal from A", "proposal from B", "proposal from C"];

    const prompt = buildCritiquePrompt("task description", allProposals, 0);

    expect(prompt).not.toContain("proposal from A");
  });

  test("includes the original task/prompt for context", () => {
    const taskPrompt = "evaluate this code for quality";

    const prompt = buildCritiquePrompt(taskPrompt, ["proposal 1", "proposal 2"], 1);

    expect(prompt).toContain(taskPrompt);
  });

  test("middle debater sees proposals from first and last but not its own", () => {
    const allProposals = ["proposal from A", "proposal from B", "proposal from C"];

    // Debater at index 1 (B) should see A and C
    const prompt = buildCritiquePrompt("task", allProposals, 1);

    expect(prompt).toContain("proposal from A");
    expect(prompt).toContain("proposal from C");
    expect(prompt).not.toContain("proposal from B");
  });

  test("last debater sees all previous proposals but not its own", () => {
    const allProposals = ["proposal X", "proposal Y", "proposal Z"];

    // Debater at index 2 (Z) should see X and Y
    const prompt = buildCritiquePrompt("task", allProposals, 2);

    expect(prompt).toContain("proposal X");
    expect(prompt).toContain("proposal Y");
    expect(prompt).not.toContain("proposal Z");
  });

  test("returns a non-empty string", () => {
    const prompt = buildCritiquePrompt("task", ["p1", "p2"], 0);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ─── buildSynthesisPrompt ────────────────────────────────────────────────────

describe("buildSynthesisPrompt()", () => {
  test("includes all proposals", () => {
    const proposals = ["proposal A", "proposal B", "proposal C"];

    const prompt = buildSynthesisPrompt(proposals, []);

    expect(prompt).toContain("proposal A");
    expect(prompt).toContain("proposal B");
    expect(prompt).toContain("proposal C");
  });

  test("includes all critiques", () => {
    const critiques = ["critique X", "critique Y"];

    const prompt = buildSynthesisPrompt(["p1", "p2"], critiques);

    expect(prompt).toContain("critique X");
    expect(prompt).toContain("critique Y");
  });

  test("works when critiques array is empty", () => {
    const prompt = buildSynthesisPrompt(["p1", "p2"], []);

    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("p1");
    expect(prompt).toContain("p2");
  });

  test("returns a non-empty string", () => {
    const prompt = buildSynthesisPrompt(["proposal 1"], []);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ─── buildJudgePrompt ────────────────────────────────────────────────────────

describe("buildJudgePrompt()", () => {
  test("includes all proposals", () => {
    const proposals = ["proposal 1", "proposal 2"];

    const prompt = buildJudgePrompt(proposals, []);

    expect(prompt).toContain("proposal 1");
    expect(prompt).toContain("proposal 2");
  });

  test("includes critiques when provided", () => {
    const prompt = buildJudgePrompt(["p1"], ["critique alpha", "critique beta"]);

    expect(prompt).toContain("critique alpha");
    expect(prompt).toContain("critique beta");
  });

  test("works when critiques array is empty", () => {
    const prompt = buildJudgePrompt(["p1", "p2"], []);

    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("p1");
  });

  test("returns a non-empty string", () => {
    const prompt = buildJudgePrompt(["proposal 1"], []);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("judge prompt is distinct from synthesis prompt", () => {
    const proposals = ["proposal A", "proposal B"];
    const critiques = ["critique C"];

    const judgePrompt = buildJudgePrompt(proposals, critiques);
    const synthesisPrompt = buildSynthesisPrompt(proposals, critiques);

    // They should be different prompts (judge vs synthesizer has different framing)
    expect(judgePrompt).not.toBe(synthesisPrompt);
  });
});
