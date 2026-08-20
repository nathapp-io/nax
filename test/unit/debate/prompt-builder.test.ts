/**
 * Tests for DebatePromptBuilder — Phase 3
 *
 * Covers all builder methods:
 * - buildProposalPrompt: taskContext + outputFormat + persona
 * - buildCritiquePrompt: excludes own proposal, includes persona
 * - buildRebuttalPrompt: sessionMode-aware taskContext, personas, labels
 * - buildSynthesisPrompt: all proposals + critiques + suffix
 * - buildJudgePrompt: all proposals + critiques, distinct framing
 * - buildClosePrompt: termination signal
 */

import { describe, expect, test } from "bun:test";
import { DebatePromptBuilder } from "@/prompts";
import { PERSONA_FRAGMENTS } from "@/debate/personas";
import type { Debater, Proposal, Rebuttal } from "@/debate/types";
import type { ComposeInput } from "@/prompts/compose";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

function makeDebater(agent: string, persona?: Debater["persona"]): Debater {
  return persona ? { agent, persona } : { agent };
}

function makeProposal(agent: string, output: string, persona?: Debater["persona"]): Proposal {
  return { debater: makeDebater(agent, persona), output };
}

function makeRebuttal(agent: string, output: string, round = 1): Rebuttal {
  return { debater: makeDebater(agent), output, round };
}

function makeBuilder(
  taskContext = "task context",
  outputFormat = "output format",
  debaters: Debater[] = [],
  sessionMode: "stateful" | "one-shot" = "stateful",
  stage = "plan",
): DebatePromptBuilder {
  return new DebatePromptBuilder(
    { taskContext, outputFormat, stage },
    { debaters, sessionMode },
  );
}

// ─── DebatePromptBuilder slot methods ────────────────────────────────────────

describe("DebatePromptBuilder slot methods", () => {
  test("proposeSlot returns ComposeInput with task section", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "json", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const result: ComposeInput = builder.proposeSlot(0);
    expect(result.task.content).toContain("task");
    expect(result.task.id).toBe("task");
    expect(result.role.id).toBe("role");
  });

  test("rebutSlot returns ComposeInput wrapping buildCritiquePrompt output", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const proposals = [
      { debater: { agent: "claude" }, output: "prop-a" },
      { debater: { agent: "opencode" }, output: "prop-b" },
    ];
    const result: ComposeInput = builder.rebutSlot(0, proposals);
    expect(result.task.content).toContain("prop-b"); // other proposal
    expect(result.task.id).toBe("task");
  });

  test("rankSlot returns ComposeInput for synthesis resolver", () => {
    const builder = new DebatePromptBuilder(
      { taskContext: "task", outputFormat: "json", stage: "review" },
      { debaters: [{ agent: "claude" }, { agent: "opencode" }], sessionMode: "one-shot" },
    );
    const proposals = [
      { debater: { agent: "claude" }, output: "prop-a" },
      { debater: { agent: "opencode" }, output: "prop-b" },
    ];
    const result: ComposeInput = builder.rankSlot(proposals, []);
    expect(result.task.content).toContain("prop-a");
    expect(result.task.content).toContain("prop-b");
    expect(result.task.id).toBe("task");
  });
});

// ─── buildProposalPrompt ─────────────────────────────────────────────────────

describe("buildProposalPrompt()", () => {
  test("includes taskContext and outputFormat in correct order", () => {
    const builder = makeBuilder("TASK_CTX", "OUTPUT_FMT");
    const prompt = builder.buildProposalPrompt(0);
    expect(prompt).toContain("TASK_CTX");
    expect(prompt).toContain("OUTPUT_FMT");
    expect(prompt.indexOf("TASK_CTX")).toBeLessThan(prompt.indexOf("OUTPUT_FMT"));
  });

  test.each([
    ["has persona", makeDebater("claude", "challenger"), true],
    ["no persona", makeDebater("claude"), false],
  ] as const)("## Your Role block when debater %s", (_label, debater, shouldInclude) => {
    const builder = makeBuilder("task", "format", [debater]);
    const prompt = builder.buildProposalPrompt(0);
    if (shouldInclude) {
      expect(prompt).toContain("## Your Role");
      expect(prompt).toContain(PERSONA_FRAGMENTS.challenger.identity);
    } else {
      expect(prompt).not.toContain("## Your Role");
    }
  });

  test("persona block appears between taskContext and outputFormat", () => {
    const debater = makeDebater("claude", "pragmatist");
    const builder = makeBuilder("TASK_CTX", "OUTPUT_FMT", [debater]);
    const prompt = builder.buildProposalPrompt(0);
    const taskIdx = prompt.indexOf("TASK_CTX");
    const roleIdx = prompt.indexOf("## Your Role");
    const fmtIdx = prompt.indexOf("OUTPUT_FMT");
    expect(taskIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(fmtIdx);
  });
});

// ─── buildCritiquePrompt ─────────────────────────────────────────────────────

describe("buildCritiquePrompt()", () => {
  const debaters = [makeDebater("agent-a"), makeDebater("agent-b"), makeDebater("agent-c")];
  const proposals = [
    makeProposal("agent-a", "proposal from A"),
    makeProposal("agent-b", "proposal from B"),
    makeProposal("agent-c", "proposal from C"),
  ];

  test("includes all other proposals but not own", () => {
    const builder = makeBuilder("task", "format", debaters);
    const prompt = builder.buildCritiquePrompt(0, proposals);
    expect(prompt).toContain("proposal from B");
    expect(prompt).toContain("proposal from C");
    expect(prompt).not.toContain("proposal from A");
  });

  test("middle debater sees first and last proposals only", () => {
    const builder = makeBuilder("task", "format", debaters);
    const prompt = builder.buildCritiquePrompt(1, proposals);
    expect(prompt).toContain("proposal from A");
    expect(prompt).toContain("proposal from C");
    expect(prompt).not.toContain("proposal from B");
  });

  test.each<[string, Debater[], Proposal[], boolean]>([
    ["has persona", [makeDebater("claude", "security"), makeDebater("gpt")], [makeProposal("claude", "p1"), makeProposal("gpt", "p2")], true],
    ["no persona", debaters, proposals, false],
  ])("## Your Role block when debater %s", (_label, debs, props, shouldInclude) => {
    const builder = makeBuilder("task", "format", debs);
    const prompt = builder.buildCritiquePrompt(0, props);
    if (shouldInclude) {
      expect(prompt).toContain("## Your Role");
      expect(prompt).toContain(PERSONA_FRAGMENTS.security.identity);
    } else {
      expect(prompt).not.toContain("## Your Role");
    }
  });

  test("includes taskContext and returns non-empty string", () => {
    const builder = makeBuilder("evaluate this code", "format", debaters);
    const result = builder.buildCritiquePrompt(0, proposals);
    expect(result).toContain("evaluate this code");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── buildRebuttalPrompt ─────────────────────────────────────────────────────

describe("buildRebuttalPrompt()", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal from agent-a"),
    makeProposal("agent-b", "proposal from agent-b"),
  ];

  test("includes ## Proposals section with all proposals", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    const result = builder.buildRebuttalPrompt(0, proposals, []);
    expect(result).toContain("## Proposals");
    expect(result).toContain("proposal from agent-a");
    expect(result).toContain("proposal from agent-b");
  });

  test.each([
    ["empty rebuttals", [], false, [] as string[]],
    ["provided rebuttals", [makeRebuttal("agent-a", "rebuttal 1"), makeRebuttal("agent-b", "rebuttal 2")], true, ["rebuttal 1", "rebuttal 2"]],
  ] as const)("## Previous Rebuttals section when %s: included=%s", (_label, rebuttals, shouldInclude, contents) => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    const result = builder.buildRebuttalPrompt(0, proposals, rebuttals as any);
    if (shouldInclude) {
      expect(result).toContain("## Previous Rebuttals");
      for (const c of contents) expect(result).toContain(c);
    } else {
      expect(result).not.toContain("## Previous Rebuttals");
    }
  });

  test.each([
    ["stateful", "stateful" as const, false],
    ["one-shot", "one-shot" as const, true],
  ])("%s mode: taskContext included=%s", (_mode, sessionMode, shouldInclude) => {
    const builder = makeBuilder("unique-task-context-string", "fmt", [], sessionMode);
    const result = builder.buildRebuttalPrompt(0, proposals, []);
    if (shouldInclude) expect(result).toContain("unique-task-context-string");
    else expect(result).not.toContain("unique-task-context-string");
  });

  test.each([
    [0, "You are debater 1"],
    [1, "You are debater 2"],
  ])("1-indexes debater number (index %i)", (index, expected) => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    expect(builder.buildRebuttalPrompt(index, proposals, [])).toContain(expected);
  });

  test("uses prose-only instruction — Do NOT output JSON", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    const result = builder.buildRebuttalPrompt(0, proposals, []);
    expect(result).toContain("Do NOT output JSON");
    expect(result).toContain("prose");
  });

  test("labels proposals with buildDebaterLabel (includes persona in label)", () => {
    const props: Proposal[] = [
      makeProposal("claude", "p1", "challenger"),
      makeProposal("gpt", "p2"),
    ];
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    const result = builder.buildRebuttalPrompt(0, props, []);
    expect(result).toContain("claude (challenger)");
    expect(result).toContain("gpt");
  });

  test.each<[string, Debater[], Proposal[], boolean]>([
    ["has persona", [makeDebater("claude", "completionist"), makeDebater("gpt")], [makeProposal("claude", "p1", "completionist"), makeProposal("gpt", "p2")], true],
    ["no persona", [makeDebater("claude")], proposals, false],
  ])("## Your Role block when rebuttal debater %s", (_label, debs, props, shouldInclude) => {
    const builder = makeBuilder("ctx", "fmt", debs, "stateful");
    const result = builder.buildRebuttalPrompt(0, props, []);
    if (shouldInclude) {
      expect(result).toContain("## Your Role");
      expect(result).toContain(PERSONA_FRAGMENTS.completionist.identity);
    } else {
      expect(result).not.toContain("## Your Role");
    }
  });
});

// ─── buildSynthesisPrompt ────────────────────────────────────────────────────

describe("buildSynthesisPrompt()", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal A"),
    makeProposal("agent-b", "proposal B"),
  ];
  const critiques = [makeRebuttal("agent-a", "critique X"), makeRebuttal("agent-b", "critique Y")];

  test("includes all proposals and critiques", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, critiques);
    expect(result).toContain("proposal A");
    expect(result).toContain("proposal B");
    expect(result).toContain("critique X");
    expect(result).toContain("critique Y");
  });

  test("handles empty critiques, optional suffix, and returns non-empty string", () => {
    const builder = makeBuilder("task", "format");
    const base = builder.buildSynthesisPrompt(proposals, []);
    expect(typeof base).toBe("string");
    expect(base.length).toBeGreaterThan(0);
    expect(base).toContain("proposal A");
    expect(base).not.toContain("undefined");
    expect(builder.buildSynthesisPrompt(proposals, [], "UNIQUE_SUFFIX")).toContain("UNIQUE_SUFFIX");
  });
});

// ─── buildJudgePrompt ────────────────────────────────────────────────────────

describe("buildJudgePrompt()", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal 1"),
    makeProposal("agent-b", "proposal 2"),
  ];
  const critiques = [makeRebuttal("agent-a", "critique alpha")];

  test("includes all proposals, critiques when provided, and works when critiques empty", () => {
    const builder = makeBuilder("task", "format");
    const withCritiques = builder.buildJudgePrompt(proposals, critiques);
    expect(withCritiques).toContain("proposal 1");
    expect(withCritiques).toContain("proposal 2");
    expect(withCritiques).toContain("critique alpha");
    expect(builder.buildJudgePrompt(proposals, []).length).toBeGreaterThan(0);
  });

  test("judge prompt is distinct from synthesis prompt", () => {
    const builder = makeBuilder("task", "format");
    const judge = builder.buildJudgePrompt(proposals, critiques);
    const synthesis = builder.buildSynthesisPrompt(proposals, critiques);
    expect(judge).not.toBe(synthesis);
  });
});

// ─── buildClosePrompt ────────────────────────────────────────────────────────

describe("buildClosePrompt()", () => {
  test("returns termination signal string", () => {
    const builder = makeBuilder();
    expect(builder.buildClosePrompt()).toBe("Close this debate session.");
  });
});

// ─── Review-specific methods (Phase 4) ──────────────────────────────────────

import type { DebateResolverContext } from "@/debate/types";
import type { Finding } from "@/findings";
import type { ReviewStoryContext } from "@/prompts";

const REVIEW_STORY: ReviewStoryContext = {
  id: "US-001",
  title: "Add debate resolver dialogue",
  acceptanceCriteria: ["AC-1: resolveDebate() works", "AC-2: reReviewDebate() references prior findings"],
};

const DIFF = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}";

const FINDING: Finding = {
  source: "semantic-review",
  rule: "missing-ac",
  severity: "error",
  category: "",
  file: "src/foo.ts",
  line: 1,
  message: "AC-1 not satisfied",
};

const LABELED_PROPOSALS: Array<{ debater: string; output: string }> = [
  { debater: "claude", output: '{"passed": false, "findings": []}' },
  { debater: "opencode", output: '{"passed": true, "findings": []}' },
];

const CRITIQUES_STRINGS = ["Proposal 1 missed edge case X", "Proposal 2 looks good"];

// ─── buildReviewPrompt ──────────────────────────────────────────────────────

describe("buildReviewPrompt()", () => {
  test.each([
    ["story id", "US-001"],
    ["story title", "Add debate resolver dialogue"],
    ["AC-1", "AC-1: resolveDebate() works"],
    ["AC-2", "AC-2: reReviewDebate() references prior findings"],
    ["the diff", DIFF],
    ["JSON 'passed' key", "passed"],
    ["JSON 'findings' key", "findings"],
  ])("includes %s", (_label, expected) => {
    expect(makeBuilder().buildReviewPrompt(DIFF, REVIEW_STORY)).toContain(expected);
  });
});

// ─── buildReReviewPrompt ────────────────────────────────────────────────────

describe("buildReReviewPrompt()", () => {
  test.each([
    ["with findings: follow-up framing + findings", [FINDING] as Finding[], (p: string) => { expect(p).toContain("follow-up"); expect(p).toContain("missing-ac"); expect(p).toContain("AC-1 not satisfied"); }],
    ["no findings: shows (none)", [] as Finding[], (p: string) => expect(p).toContain("(none)")],
  ])("buildReReviewPrompt %s", (_label, findings, assert) => {
    assert(makeBuilder().buildReReviewPrompt(DIFF, findings));
  });

  test.each([
    ["updated diff", DIFF],
    ["deltaSummary in JSON", "deltaSummary"],
  ])("buildReReviewPrompt includes %s", (_label, expected) => {
    expect(makeBuilder().buildReReviewPrompt(DIFF, [FINDING])).toContain(expected);
  });
});

// ─── buildResolverPrompt ────────────────────────────────────────────────────

describe("buildResolverPrompt()", () => {
  test.each([
    ["labeled debater proposals", (p: string) => { expect(p).toContain("claude"); expect(p).toContain("opencode"); expect(p).toContain(LABELED_PROPOSALS[0].output); expect(p).toContain(LABELED_PROPOSALS[1].output); }],
    ["critiques when present", (p: string) => expect(p).toContain(CRITIQUES_STRINGS[0])],
    ["diff", (p: string) => expect(p).toContain(DIFF)],
    ["acceptance criteria", (p: string) => expect(p).toContain("AC-1: resolveDebate() works")],
    ["JSON response fields (passed + findings)", (p: string) => { expect(p).toContain("passed"); expect(p).toContain("findings"); }],
    ["tool verification", (p: string) => expect(p.toLowerCase()).toMatch(/verif|tool/)],
  ])("buildResolverPrompt(synthesis) includes %s", (_label, assert) => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = makeBuilder().buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    assert(prompt);
  });

  test("omits critiques section when empty", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = makeBuilder().buildResolverPrompt(LABELED_PROPOSALS, [], { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).not.toContain("Critiques");
  });

  test("ref mode production diff uses resolver-provided pathspec, omits TypeScript literals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = makeBuilder().buildResolverPrompt(
      LABELED_PROPOSALS,
      CRITIQUES_STRINGS,
      { mode: "ref" as const, storyGitRef: "abc123", stat: "1 file changed", productionExcludePatterns: [":!*_test.go", ":!tests/test_*.py"] },
      REVIEW_STORY,
      ctx,
    );
    expect(prompt).toContain(":!*_test.go");
    expect(prompt).toContain(":!tests/test_*.py");
    expect(prompt).not.toContain(":!*.test.ts");
    expect(prompt).not.toContain(":!*.spec.ts");
  });

  test.each([
    ["synthesis", { resolverType: "synthesis" as const }, /synthes/i],
    ["custom", { resolverType: "custom" as const }, /judge/i],
  ])("resolverType=%s uses correct framing", (_type, ctx, pattern) => {
    const prompt = makeBuilder().buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt.toLowerCase()).toMatch(pattern);
  });

  test.each([
    ["majority-fail-closed", { resolverType: "majority-fail-closed" as const, majorityVote: { passed: false, passCount: 1, failCount: 1 } }, ["1 passed", "1 failed"]],
    ["majority-fail-open", { resolverType: "majority-fail-open" as const, majorityVote: { passed: true, passCount: 2, failCount: 0 } }, ["2 passed"]],
  ] as const)("%s: includes vote tally", (_label, ctx, expectedPhrases) => {
    const prompt = makeBuilder().buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    for (const phrase of expectedPhrases) expect(prompt).toContain(phrase);
  });

});

// ─── buildReResolverPrompt ──────────────────────────────────────────────────

describe("buildReResolverPrompt()", () => {
  test.each([
    ["with findings: framing + findings + proposals", [FINDING] as Finding[], (p: string) => { expect(p.toLowerCase()).toMatch(/re-review|follow-up|previous finding/); expect(p).toContain("missing-ac"); expect(p).toContain("AC-1 not satisfied"); expect(p).toContain("claude"); expect(p).toContain("opencode"); }],
    ["no findings: shows (none)", [] as Finding[], (p: string) => expect(p).toContain("(none)")],
  ])("buildReResolverPrompt %s", (_label, findings, assert) => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    assert(makeBuilder().buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, findings, ctx));
  });

  test.each([
    ["updated diff", DIFF],
    ["deltaSummary in JSON", "deltaSummary"],
  ])("buildReResolverPrompt includes %s", (_label, expected) => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    expect(makeBuilder().buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx)).toContain(expected);
  });
});

// ─── Issue 7: critique prompt assembly order ──────────────────────────────────

describe("buildCritiquePrompt() — issue 7: assembly order", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal A"),
    makeProposal("agent-b", "proposal B"),
  ];

  test("persona block appears before taskContext", () => {
    const debater = makeDebater("claude", "challenger");
    const builder = makeBuilder("TASK_CTX", "OUTPUT_FMT", [debater]);
    const prompt = builder.buildCritiquePrompt(0, proposals);
    const roleIdx = prompt.indexOf("## Your Role");
    const taskIdx = prompt.indexOf("TASK_CTX");
    expect(roleIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeLessThan(taskIdx);
  });

  test("does not append prose critique instruction after JSON-only gate in taskContext", () => {
    const taskCtxWithJsonGate =
      "IMPORTANT: Your entire response must be a single JSON object.\nOutput ONLY the JSON.";
    const builder = makeBuilder(taskCtxWithJsonGate, "OUTPUT_FMT", []);
    const prompt = builder.buildCritiquePrompt(0, proposals);
    expect(prompt).not.toContain("Please critique these proposals");
  });
});

// ─── Issue 8: explicit finding schema ────────────────────────────────────────

describe("finding schema — issue 8: explicit fields", () => {
  const ctx: DebateResolverContext = { resolverType: "synthesis" };

  test.each([
    ["buildReviewPrompt", () => makeBuilder().buildReviewPrompt(DIFF, REVIEW_STORY)],
    ["buildResolverPrompt", () => makeBuilder().buildResolverPrompt(LABELED_PROPOSALS, [], { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx)],
  ])("%s includes ruleId, severity, message in schema", (_name, getPrompt) => {
    const prompt = getPrompt();
    expect(prompt).toContain("ruleId");
    expect(prompt).toContain("severity");
    expect(prompt).toContain("message");
  });

  test("findingReasoning key references ruleId not bare [id]", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain("[ruleId");
  });
});

// ─── Issue 9: consistent JSON fencing in proposals section ───────────────────

describe("buildResolverPrompt() — issue 9: consistent JSON fencing", () => {
  test("each debater proposal is wrapped in ```json fencing", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, [], { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    const fenceCount = (prompt.match(/```json/g) ?? []).length;
    expect(fenceCount).toBe(LABELED_PROPOSALS.length);
  });
});
