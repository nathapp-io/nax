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
import { DebatePromptBuilder } from "../../../src/prompts";
import { PERSONA_FRAGMENTS } from "../../../src/debate/personas";
import type { Debater, Proposal, Rebuttal } from "../../../src/debate/types";
import type { ComposeInput } from "../../../src/prompts/compose";

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
  test("includes taskContext", () => {
    const builder = makeBuilder("the task spec", "json schema");
    expect(builder.buildProposalPrompt(0)).toContain("the task spec");
  });

  test("includes outputFormat", () => {
    const builder = makeBuilder("task ctx", "json output format");
    expect(builder.buildProposalPrompt(0)).toContain("json output format");
  });

  test("outputFormat appears after taskContext", () => {
    const builder = makeBuilder("TASK_CTX", "OUTPUT_FMT");
    const prompt = builder.buildProposalPrompt(0);
    expect(prompt.indexOf("TASK_CTX")).toBeLessThan(prompt.indexOf("OUTPUT_FMT"));
  });

  test("injects ## Your Role block when debater has persona", () => {
    const debater = makeDebater("claude", "challenger");
    const builder = makeBuilder("task", "format", [debater]);
    const prompt = builder.buildProposalPrompt(0);
    expect(prompt).toContain("## Your Role");
    expect(prompt).toContain(PERSONA_FRAGMENTS.challenger.identity);
  });

  test("no ## Your Role block when debater has no persona", () => {
    const debater = makeDebater("claude");
    const builder = makeBuilder("task", "format", [debater]);
    expect(builder.buildProposalPrompt(0)).not.toContain("## Your Role");
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

  test("includes taskContext", () => {
    const builder = makeBuilder("evaluate this code", "format", debaters);
    expect(builder.buildCritiquePrompt(0, proposals)).toContain("evaluate this code");
  });

  test("injects ## Your Role block when debater has persona", () => {
    const debs = [makeDebater("claude", "security"), makeDebater("gpt")];
    const props = [makeProposal("claude", "p1"), makeProposal("gpt", "p2")];
    const builder = makeBuilder("task", "format", debs);
    const prompt = builder.buildCritiquePrompt(0, props);
    expect(prompt).toContain("## Your Role");
    expect(prompt).toContain(PERSONA_FRAGMENTS.security.identity);
  });

  test("no ## Your Role block when debater has no persona", () => {
    const builder = makeBuilder("task", "format", debaters);
    expect(builder.buildCritiquePrompt(0, proposals)).not.toContain("## Your Role");
  });

  test("returns a non-empty string", () => {
    const builder = makeBuilder("task", "format", debaters);
    const result = builder.buildCritiquePrompt(0, proposals);
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

  test("no ## Previous Rebuttals section when rebuttals is empty", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    expect(builder.buildRebuttalPrompt(0, proposals, [])).not.toContain("## Previous Rebuttals");
  });

  test("includes ## Previous Rebuttals section when rebuttals provided", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    const rebuttals = [makeRebuttal("agent-a", "rebuttal 1"), makeRebuttal("agent-b", "rebuttal 2")];
    const result = builder.buildRebuttalPrompt(0, proposals, rebuttals);
    expect(result).toContain("## Previous Rebuttals");
    expect(result).toContain("rebuttal 1");
    expect(result).toContain("rebuttal 2");
  });

  test("stateful mode: does NOT include taskContext", () => {
    const builder = makeBuilder("unique-task-context-string", "fmt", [], "stateful");
    expect(builder.buildRebuttalPrompt(0, proposals, [])).not.toContain("unique-task-context-string");
  });

  test("one-shot mode: DOES include taskContext", () => {
    const builder = makeBuilder("unique-task-context-string", "fmt", [], "one-shot");
    expect(builder.buildRebuttalPrompt(0, proposals, [])).toContain("unique-task-context-string");
  });

  test("1-indexes debater number (index 0 → debater 1)", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    expect(builder.buildRebuttalPrompt(0, proposals, [])).toContain("You are debater 1");
  });

  test("1-indexes debater number (index 1 → debater 2)", () => {
    const builder = makeBuilder("ctx", "fmt", [], "stateful");
    expect(builder.buildRebuttalPrompt(1, proposals, [])).toContain("You are debater 2");
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

  test("injects ## Your Role block when current debater has persona", () => {
    const debs = [makeDebater("claude", "completionist"), makeDebater("gpt")];
    const props: Proposal[] = [
      makeProposal("claude", "p1", "completionist"),
      makeProposal("gpt", "p2"),
    ];
    const builder = makeBuilder("ctx", "fmt", debs, "stateful");
    const result = builder.buildRebuttalPrompt(0, props, []);
    expect(result).toContain("## Your Role");
    expect(result).toContain(PERSONA_FRAGMENTS.completionist.identity);
  });

  test("no ## Your Role block when debater has no persona", () => {
    const builder = makeBuilder("ctx", "fmt", [makeDebater("claude")], "stateful");
    expect(builder.buildRebuttalPrompt(0, proposals, [])).not.toContain("## Your Role");
  });
});

// ─── buildSynthesisPrompt ────────────────────────────────────────────────────

describe("buildSynthesisPrompt()", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal A"),
    makeProposal("agent-b", "proposal B"),
  ];
  const critiques = [makeRebuttal("agent-a", "critique X"), makeRebuttal("agent-b", "critique Y")];

  test("includes all proposals", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, []);
    expect(result).toContain("proposal A");
    expect(result).toContain("proposal B");
  });

  test("includes all critiques", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, critiques);
    expect(result).toContain("critique X");
    expect(result).toContain("critique Y");
  });

  test("works when critiques is empty", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, []);
    expect(typeof result).toBe("string");
    expect(result).toContain("proposal A");
  });

  test("appends promptSuffix when provided", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, [], "UNIQUE_SUFFIX");
    expect(result).toContain("UNIQUE_SUFFIX");
  });

  test("no promptSuffix when not provided", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildSynthesisPrompt(proposals, []);
    expect(result).not.toContain("undefined");
  });

  test("returns a non-empty string", () => {
    const builder = makeBuilder("task", "format");
    expect(builder.buildSynthesisPrompt(proposals, []).length).toBeGreaterThan(0);
  });
});

// ─── buildJudgePrompt ────────────────────────────────────────────────────────

describe("buildJudgePrompt()", () => {
  const proposals: Proposal[] = [
    makeProposal("agent-a", "proposal 1"),
    makeProposal("agent-b", "proposal 2"),
  ];
  const critiques = [makeRebuttal("agent-a", "critique alpha")];

  test("includes all proposals", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildJudgePrompt(proposals, []);
    expect(result).toContain("proposal 1");
    expect(result).toContain("proposal 2");
  });

  test("includes critiques when provided", () => {
    const builder = makeBuilder("task", "format");
    const result = builder.buildJudgePrompt(proposals, critiques);
    expect(result).toContain("critique alpha");
  });

  test("works when critiques is empty", () => {
    const builder = makeBuilder("task", "format");
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

import type { DebateResolverContext } from "../../../src/debate/types";
import type { Finding } from "../../../src/findings";
import type { ReviewStoryContext } from "../../../src/prompts";

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
  test("includes story id and title", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain("US-001");
    expect(prompt).toContain("Add debate resolver dialogue");
  });

  test("includes acceptance criteria", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain("AC-1: resolveDebate() works");
    expect(prompt).toContain("AC-2: reReviewDebate() references prior findings");
  });

  test("includes the diff", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain(DIFF);
  });

  test("asks for JSON response with passed + findings", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain("passed");
    expect(prompt).toContain("findings");
  });
});

// ─── buildReReviewPrompt ────────────────────────────────────────────────────

describe("buildReReviewPrompt()", () => {
  test("includes follow-up framing", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("follow-up");
  });

  test("includes previous findings", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("missing-ac");
    expect(prompt).toContain("AC-1 not satisfied");
  });

  test("shows (none) when no previous findings", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReReviewPrompt(DIFF, []);
    expect(prompt).toContain("(none)");
  });

  test("includes updated diff", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain(DIFF);
  });

  test("asks for deltaSummary in JSON", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("deltaSummary");
  });
});

// ─── buildResolverPrompt ────────────────────────────────────────────────────

describe("buildResolverPrompt()", () => {
  test("includes labeled debater proposals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("opencode");
    expect(prompt).toContain(LABELED_PROPOSALS[0].output);
    expect(prompt).toContain(LABELED_PROPOSALS[1].output);
  });

  test("includes critiques when present", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain(CRITIQUES_STRINGS[0]);
  });

  test("omits critiques section when empty", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, [], { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).not.toContain("Critiques");
  });

  test("includes diff", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain(DIFF);
  });

  test("ref mode production diff uses provided exclusion pathspec", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(
      LABELED_PROPOSALS,
      CRITIQUES_STRINGS,
      {
        mode: "ref" as const,
        storyGitRef: "abc123",
        stat: "1 file changed",
        productionExcludePatterns: [":!*_test.go", ":!tests/test_*.py"],
      },
      REVIEW_STORY,
      ctx,
    );

    expect(prompt).toContain(":!*_test.go");
    expect(prompt).toContain(":!tests/test_*.py");
  });

  test("ref mode production diff omits hardcoded TypeScript exclusion literals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(
      LABELED_PROPOSALS,
      CRITIQUES_STRINGS,
      {
        mode: "ref" as const,
        storyGitRef: "abc123",
        stat: "1 file changed",
        productionExcludePatterns: [":!*_test.go"],
      },
      REVIEW_STORY,
      ctx,
    );

    expect(prompt).not.toContain(":!*.test.ts");
    expect(prompt).not.toContain(":!*.spec.ts");
  });

  test("includes acceptance criteria", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain("AC-1: resolveDebate() works");
  });

  test("synthesis type: instructs to synthesize", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt.toLowerCase()).toContain("synthes");
  });

  test("custom type: instructs judge framing", () => {
    const ctx: DebateResolverContext = { resolverType: "custom" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt.toLowerCase()).toContain("judge");
  });

  test("majority-fail-closed: includes vote tally", () => {
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-closed",
      majorityVote: { passed: false, passCount: 1, failCount: 1 },
    };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain("1 passed");
    expect(prompt).toContain("1 failed");
  });

  test("majority-fail-open: includes vote tally with fail-open note", () => {
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-open",
      majorityVote: { passed: true, passCount: 2, failCount: 0 },
    };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain("2 passed");
  });

  test("asks for JSON response with passed + findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt).toContain("passed");
    expect(prompt).toContain("findings");
  });

  test("instructs tool verification", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
    expect(prompt.toLowerCase()).toMatch(/verif|tool/);
  });
});

// ─── buildReResolverPrompt ──────────────────────────────────────────────────

describe("buildReResolverPrompt()", () => {
  test("includes re-review framing", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx);
    expect(prompt.toLowerCase()).toMatch(/re-review|follow-up|previous finding/);
  });

  test("includes previous findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx);
    expect(prompt).toContain("missing-ac");
    expect(prompt).toContain("AC-1 not satisfied");
  });

  test("shows (none) when no previous findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [], ctx);
    expect(prompt).toContain("(none)");
  });

  test("includes labeled debater proposals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("opencode");
  });

  test("includes updated diff", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx);
    expect(prompt).toContain(DIFF);
  });

  test("asks for deltaSummary in JSON", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const builder = makeBuilder();
    const prompt = builder.buildReResolverPrompt(LABELED_PROPOSALS, CRITIQUES_STRINGS, { mode: "embedded" as const, diff: DIFF }, [FINDING], ctx);
    expect(prompt).toContain("deltaSummary");
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

  test("buildReviewPrompt includes ruleId, severity, message in schema", () => {
    const builder = makeBuilder();
    const prompt = builder.buildReviewPrompt(DIFF, REVIEW_STORY);
    expect(prompt).toContain("ruleId");
    expect(prompt).toContain("severity");
    expect(prompt).toContain("message");
  });

  test("buildResolverPrompt includes ruleId, severity, message in schema", () => {
    const builder = makeBuilder();
    const prompt = builder.buildResolverPrompt(LABELED_PROPOSALS, [], { mode: "embedded" as const, diff: DIFF }, REVIEW_STORY, ctx);
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
