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
import {
  buildCritiquePrompt,
  buildJudgePrompt,
  buildSynthesisPrompt,
  buildRebuttalContext,
} from "../../../src/debate/prompts";
import { PERSONA_FRAGMENTS } from "../../../src/debate/personas";
import type { Debater } from "../../../src/debate/types";

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

// ─── buildRebuttalContext ────────────────────────────────────────────────────

describe("buildRebuttalContext()", () => {
  test("with 2 proposals and 0 rebuttals returns string containing '## Proposals' section with both proposals and no '## Previous Rebuttals' section", () => {
    const taskContext = "original task context";
    const debater1: Debater = { agent: "agent-a" };
    const debater2: Debater = { agent: "agent-b" };
    const proposals = [
      { debater: debater1, output: "proposal from agent-a" },
      { debater: debater2, output: "proposal from agent-b" },
    ];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(result).toContain("## Proposals");
    expect(result).toContain("proposal from agent-a");
    expect(result).toContain("proposal from agent-b");
    expect(result).not.toContain("## Previous Rebuttals");
  });

  test("with 2 proposals and 3 rebuttals returns string containing '## Previous Rebuttals' section with all 3 rebuttals numbered", () => {
    const taskContext = "original task context";
    const debater1: Debater = { agent: "agent-a" };
    const debater2: Debater = { agent: "agent-b" };
    const proposals = [
      { debater: debater1, output: "proposal from agent-a" },
      { debater: debater2, output: "proposal from agent-b" },
    ];
    const rebuttalOutputs = ["rebuttal 1", "rebuttal 2", "rebuttal 3"];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(result).toContain("## Previous Rebuttals");
    expect(result).toContain("rebuttal 1");
    expect(result).toContain("rebuttal 2");
    expect(result).toContain("rebuttal 3");
  });

  test("with currentDebaterIndex 0 returns string containing 'You are debater 1' (1-indexed in output)", () => {
    const taskContext = "original task context";
    const debater1: Debater = { agent: "agent-a" };
    const debater2: Debater = { agent: "agent-b" };
    const proposals = [
      { debater: debater1, output: "proposal from agent-a" },
      { debater: debater2, output: "proposal from agent-b" },
    ];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(result).toContain("You are debater 1");
  });

  test("includes each proposal labeled with the debater's agent name", () => {
    const taskContext = "original task context";
    const debater1: Debater = { agent: "claude-3-opus" };
    const debater2: Debater = { agent: "gpt-4-turbo" };
    const proposals = [
      { debater: debater1, output: "opus proposal content" },
      { debater: debater2, output: "gpt proposal content" },
    ];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(result).toContain("claude-3-opus");
    expect(result).toContain("gpt-4-turbo");
    expect(result).toContain("opus proposal content");
    expect(result).toContain("gpt proposal content");
  });

  test("returns a non-empty string", () => {
    const taskContext = "test task context";
    const debater: Debater = { agent: "test-agent" };
    const proposals = [{ debater, output: "test output" }];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("stateful mode: does NOT include taskContext (debater already saw it in proposal turn)", () => {
    const taskContext = "custom task description for rebuttal";
    const debater: Debater = { agent: "test-agent" };
    const proposals = [{ debater, output: "test output" }];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    expect(result).not.toContain(taskContext);
  });

  test("one-shot mode: includes taskContext (each round is a fresh prompt with no prior context)", () => {
    const taskContext = "custom task description for rebuttal";
    const debater: Debater = { agent: "test-agent" };
    const proposals = [{ debater, output: "test output" }];
    const rebuttalOutputs: string[] = [];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "one-shot");

    expect(result).toContain(taskContext);
  });

  test("uses prose-only instruction — no JSON output directive", () => {
    const taskContext = "task context";
    const debater: Debater = { agent: "agent-a" };
    const proposals = [{ debater, output: "proposal" }];

    const result = buildRebuttalContext(taskContext, proposals, [], 0, "stateful");

    expect(result).toContain("Do NOT output JSON");
    expect(result).toContain("prose");
  });

  test("correctly 1-indexes debater number for different indices", () => {
    const taskContext = "original task context";
    const debater1: Debater = { agent: "agent-a" };
    const debater2: Debater = { agent: "agent-b" };
    const debater3: Debater = { agent: "agent-c" };
    const proposals = [
      { debater: debater1, output: "proposal 1" },
      { debater: debater2, output: "proposal 2" },
      { debater: debater3, output: "proposal 3" },
    ];
    const rebuttalOutputs: string[] = [];

    // Debater at index 0 should see "You are debater 1"
    const result0 = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");
    expect(result0).toContain("You are debater 1");

    // Debater at index 1 should see "You are debater 2"
    const result1 = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 1, "stateful");
    expect(result1).toContain("You are debater 2");

    // Debater at index 2 should see "You are debater 3"
    const result2 = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 2, "stateful");
    expect(result2).toContain("You are debater 3");
  });

  test("rebuttals section includes numbered rebuttals", () => {
    const taskContext = "original task context";
    const debater: Debater = { agent: "agent-a" };
    const proposals = [{ debater, output: "proposal" }];
    const rebuttalOutputs = ["first rebuttal", "second rebuttal"];

    const result = buildRebuttalContext(taskContext, proposals, rebuttalOutputs, 0, "stateful");

    // Check that rebuttals are numbered
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("first rebuttal");
    expect(result).toContain("second rebuttal");
  });

  test("persona debater: label includes 'agent (persona)' format in proposals section", () => {
    const debaterWithPersona: Debater = { agent: "claude", persona: "challenger" };
    const debaterPlain: Debater = { agent: "gpt" };
    const proposals = [
      { debater: debaterWithPersona, output: "proposal A" },
      { debater: debaterPlain, output: "proposal B" },
    ];

    const result = buildRebuttalContext("ctx", proposals, [], 1, "stateful");

    expect(result).toContain("claude (challenger)");
    expect(result).toContain("gpt");
  });

  test("persona debater: injects ## Your Role block before ## Your Task", () => {
    const debaterWithPersona: Debater = { agent: "claude", persona: "pragmatist" };
    const proposals = [
      { debater: debaterWithPersona, output: "proposal A" },
      { debater: { agent: "gpt" }, output: "proposal B" },
    ];

    const result = buildRebuttalContext("ctx", proposals, [], 0, "stateful");

    expect(result).toContain("## Your Role");
    expect(result).toContain(PERSONA_FRAGMENTS.pragmatist.identity);
    // Role block must appear before task block
    expect(result.indexOf("## Your Role")).toBeLessThan(result.indexOf("## Your Task"));
  });

  test("no persona: does not inject ## Your Role block", () => {
    const debater: Debater = { agent: "claude" };
    const proposals = [{ debater, output: "proposal" }];

    const result = buildRebuttalContext("ctx", proposals, [], 0, "stateful");

    expect(result).not.toContain("## Your Role");
  });
});

// ─── buildCritiquePrompt persona injection ───────────────────────────────────

describe("buildCritiquePrompt() persona injection", () => {
  test("with persona: injects ## Your Role block after task", () => {
    const debaterWithPersona: Debater = { agent: "claude", persona: "security" };

    const result = buildCritiquePrompt("evaluate this code", ["p1", "p2"], 0, debaterWithPersona);

    expect(result).toContain("## Your Role");
    expect(result).toContain(PERSONA_FRAGMENTS.security.identity);
    expect(result).toContain("## Task");
    expect(result.indexOf("## Your Role")).toBeGreaterThan(result.indexOf("## Task"));
  });

  test("without currentDebater: no ## Your Role block", () => {
    const result = buildCritiquePrompt("evaluate this code", ["p1", "p2"], 0);

    expect(result).not.toContain("## Your Role");
  });

  test("with debater but no persona: no ## Your Role block", () => {
    const debaterPlain: Debater = { agent: "claude" };

    const result = buildCritiquePrompt("evaluate this code", ["p1", "p2"], 0, debaterPlain);

    expect(result).not.toContain("## Your Role");
  });
});
