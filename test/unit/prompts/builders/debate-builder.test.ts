/**
 * Unit tests for DebatePromptBuilder.proposeSlot — citationsRequired gate (AC-5)
 */

import { describe, expect, test } from "bun:test";
import type { DebateResolverContext, Debater } from "@/debate/types";
import type { PromptBuilderOptions, ReviewStoryContext, StageContext } from "@/prompts";
import { DebatePromptBuilder } from "@/prompts";

const debaters: Debater[] = [
  { agent: "claude", model: "fast" },
  { agent: "opencode", model: "fast" },
];

function makeStageContext(overrides: Partial<StageContext> = {}): StageContext {
  return {
    taskContext: "Implement feature X",
    outputFormat: "Respond with JSON",
    stage: "review",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<PromptBuilderOptions> = {}): PromptBuilderOptions {
  return {
    debaters,
    sessionMode: "one-shot",
    ...overrides,
  };
}

describe("DebatePromptBuilder.proposeSlot — citationsRequired gate", () => {
  test("output is unchanged when citationsRequired is false", () => {
    const withFalse = new DebatePromptBuilder(
      makeStageContext(),
      makeOptions({ proposers: { citationsRequired: false } }),
    );
    const withUndefined = new DebatePromptBuilder(makeStageContext(), makeOptions());

    expect(withFalse.proposeSlot(0).task.content).toBe(withUndefined.proposeSlot(0).task.content);
  });

  test("output is unchanged when proposers is omitted", () => {
    const withProposers = new DebatePromptBuilder(makeStageContext(), makeOptions({ proposers: undefined }));
    const withoutProposers = new DebatePromptBuilder(makeStageContext(), makeOptions());

    expect(withProposers.proposeSlot(0).task.content).toBe(withoutProposers.proposeSlot(0).task.content);
  });

  test("includes citations-required instruction when citationsRequired === true", () => {
    const builder = new DebatePromptBuilder(
      makeStageContext(),
      makeOptions({ proposers: { citationsRequired: true } }),
    );
    const slot = builder.proposeSlot(0);
    expect(slot.task.content).toContain("cite");
  });

  test("citation instruction absent when citationsRequired === false", () => {
    const builderFalse = new DebatePromptBuilder(
      makeStageContext(),
      makeOptions({ proposers: { citationsRequired: false } }),
    );
    const builderTrue = new DebatePromptBuilder(
      makeStageContext(),
      makeOptions({ proposers: { citationsRequired: true } }),
    );
    const contentFalse = builderFalse.proposeSlot(0).task.content;
    const contentTrue = builderTrue.proposeSlot(0).task.content;

    // Extra content present only when true
    expect(contentTrue.length).toBeGreaterThan(contentFalse.length);
  });

  test("proposeSlot returns ComposeInput with role and task", () => {
    const builder = new DebatePromptBuilder(makeStageContext(), makeOptions());
    const slot = builder.proposeSlot(0);
    expect(slot.role.id).toBe("role");
    expect(slot.task.id).toBe("task");
  });

  test("taskContext appears in proposal prompt", () => {
    const builder = new DebatePromptBuilder(
      makeStageContext({ taskContext: "unique-task-context-abc" }),
      makeOptions(),
    );
    const slot = builder.proposeSlot(0);
    expect(slot.task.content).toContain("unique-task-context-abc");
  });
});

// ─── ref-mode diff frame (repo-rooted cwd) ───────────────────────────────────

const REVIEW_STORY: ReviewStoryContext = {
  id: "US-001",
  title: "Scope the debate diff",
  acceptanceCriteria: ["The diff is scoped to the story package"],
};

const RESOLVER_CTX: DebateResolverContext = { resolverType: "synthesis" };

function resolverPrompt(pathspec: string): string {
  return new DebatePromptBuilder(makeStageContext(), makeOptions()).buildResolverPrompt(
    [{ debater: "claude", output: "{}" }],
    [],
    {
      mode: "ref",
      storyGitRef: "abc123",
      stat: "1 file changed",
      productionExcludePatterns: [":!*.test.ts"],
      pathspec,
    },
    REVIEW_STORY,
    RESOLVER_CTX,
  );
}

describe("DebatePromptBuilder.buildResolverPrompt — ref-mode diff frame", () => {
  test("package pathspec: every diff command drops --relative and scopes to the package", () => {
    const prompt = resolverPrompt("packages/api");
    const diffLines = prompt.split("\n").filter((line) => line.includes("git diff "));
    const logLines = prompt.split("\n").filter((line) => line.includes("git log "));

    expect(diffLines.length).toBeGreaterThan(0);
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of diffLines) {
      expect(line).not.toContain("--relative");
      expect(line).toContain("-- packages/api");
      expect(line).not.toContain("-- .");
    }
    for (const line of logLines) {
      // `git log --oneline` prints no paths, so it takes no pathspec.
      expect(line).toContain("git log --oneline abc123..HEAD");
      expect(line).not.toContain("--relative");
    }
  });

  test("repo-root pathspec still renders the root pathspec (-- .)", () => {
    const diffLines = resolverPrompt(".")
      .split("\n")
      .filter((line) => line.includes("git diff "));
    expect(diffLines.length).toBeGreaterThan(0);
    for (const line of diffLines) {
      expect(line).not.toContain("--relative");
      expect(line).toContain("-- .");
    }
  });
});
