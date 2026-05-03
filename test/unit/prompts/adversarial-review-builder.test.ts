/**
 * Unit tests for src/prompts/builders/adversarial-review-builder.ts
 *
 * Covers:
 * - ref mode: story block, git diff command with storyGitRef, stat block
 * - embedded mode: full diff code block, testInventory untested files, diff without inventory
 * - custom rules: included in prompt when present
 * - prior failures: escalation attempt context included
 * - output schema: passed field and severity values present
 * - role section: adversarial cognitive stance ("find what is WRONG")
 * - no diff available: fallback message when neither diff nor storyGitRef provided
 */

import { describe, expect, test } from "bun:test";
import { AdversarialReviewPromptBuilder } from "../../../src/prompts/builders/adversarial-review-builder";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "STORY-001",
  title: "Add user auth",
  description: "Implements authentication",
  acceptanceCriteria: ["Users can log in", "Sessions expire after 24h"],
};

const CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 180_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 2,
};

const STORY_GIT_REF = "abc1234def";

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
+export async function login(user: string, pass: string) {}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const builder = new AdversarialReviewPromptBuilder();

// ─── ref mode ─────────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — ref mode", () => {
  test("prompt contains story title", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY.title);
  });

  test("prompt contains story id", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY.id);
  });

  test("prompt contains acceptance criteria", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("Users can log in");
    expect(result).toContain("Sessions expire after 24h");
  });

  test("prompt contains the ref-based diff section with git diff command", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(`git diff --unified=3 ${STORY_GIT_REF}..HEAD`);
  });

  test("prompt contains the storyGitRef as baseline ref label", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain(STORY_GIT_REF);
  });

  test("prompt contains stat block when stat is provided", () => {
    const stat = "src/auth/login.ts | 10 ++++++++++\n 1 file changed";
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      stat,
    });

    expect(result).toContain(stat);
    expect(result).toContain("Changed Files Summary");
  });

  test("stat block is omitted when stat is not provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).not.toContain("Changed Files Summary");
  });

  test("ref mode uses resolver-provided test patterns in test-audit workflow", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      testGlobs: ["**/*_test.go", "tests/test_*.py"],
      refExcludePatterns: [":!*_test.go", ":!tests/test_*.py"],
    });

    expect(result).toContain("**/*_test.go");
    expect(result).toContain("tests/test_*.py");
    expect(result).toContain(":!*_test.go");
  });

  test("ref mode does not include hardcoded TypeScript test layout literals", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      testGlobs: ["**/*_test.go"],
      refExcludePatterns: [":!*_test.go"],
    });

    expect(result).not.toContain("src/**.ts");
    expect(result).not.toContain("test/**/**.test.ts");
  });
});

// ─── embedded mode ────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — embedded mode", () => {
  test("prompt contains the full diff in a diff code block", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
    });

    expect(result).toContain("```diff\n" + DIFF);
  });

  test("prompt includes untested source files from testInventory", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
      testInventory: {
        addedTestFiles: [],
        newSourceFilesWithoutTests: ["src/auth/login.ts", "src/auth/session.ts"],
      },
    });

    expect(result).toContain("src/auth/login.ts");
    expect(result).toContain("src/auth/session.ts");
    expect(result).toContain("## Test Audit");
  });

  test("prompt still contains diff when testInventory is not provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
    });

    expect(result).toContain(DIFF);
  });

  test("test audit block is omitted when all source files have matching tests", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      diff: DIFF,
      testInventory: {
        addedTestFiles: ["test/unit/auth/login.test.ts"],
        newSourceFilesWithoutTests: [],
      },
    });

    // The dynamic "## Test Audit" section (from TestInventory) should not appear
    // when newSourceFilesWithoutTests is empty. Note: the static heuristics block
    // contains "Test Audit Gap" — we check for the dynamic section header specifically.
    expect(result).not.toContain("## Test Audit");
  });
});

// ─── custom rules ─────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — custom rules", () => {
  test("prompt contains custom rule text when rules are set in config", () => {
    const configWithRules: AdversarialReviewConfig = {
      ...CONFIG,
      rules: ["Always check for missing storyId in logger calls", "Flag any direct spawn() without _deps"],
    };

    const result = builder.buildAdversarialReviewPrompt(STORY, configWithRules, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("Always check for missing storyId in logger calls");
    expect(result).toContain("Flag any direct spawn() without _deps");
  });

  test("custom rules section is omitted when rules array is empty", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).not.toContain("Project-Specific Adversarial Rules");
  });
});



// ─── output schema ────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — output schema", () => {
  test('prompt contains "passed" field in output schema', () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain('"passed"');
  });

  test("prompt contains severity values in output schema", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain('"error"');
    expect(result).toContain('"warning"');
    expect(result).toContain('"info"');
    expect(result).toContain('"unverifiable"');
  });
});

// ─── role section ─────────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — role section", () => {
  test('prompt contains adversarial role description ("find what is WRONG")', () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("find what is WRONG");
  });

  test("prompt contains adversarial reviewer identity declaration", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });

    expect(result).toContain("adversarial code reviewer");
  });
});

// ─── no diff available ────────────────────────────────────────────────────────

describe("AdversarialReviewPromptBuilder — no diff available", () => {
  test("fallback message appears when neither diff nor storyGitRef are provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "embedded",
      // no diff, no storyGitRef
    });

    expect(result).toContain("No diff available");
  });

  test("fallback message present when mode is ref but no storyGitRef provided", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      // storyGitRef intentionally omitted
    });

    expect(result).toContain("No diff available");
  });
});

// ─── prior adversarial iterations (ADR-022 phase 5) ──────────────────────────

describe("AdversarialReviewPromptBuilder — priorAdversarialIterations", () => {
  const PRIOR_ITERATIONS = [
    {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [{ strategyName: "source-fix", op: "source-fix", targetFiles: ["src/auth/login.ts"], summary: "", costUsd: 0 }],
      findingsAfter: [
        {
          source: "adversarial-review" as const,
          severity: "error" as const,
          category: "error-path",
          file: "src/auth/login.ts",
          line: 42,
          message: "Null pointer dereference on empty input",
        },
        {
          source: "adversarial-review" as const,
          severity: "warning" as const,
          category: "convention",
          file: "src/auth/session.ts",
          message: "Missing storyId in logger call",
        },
      ],
      outcome: "partial" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    },
  ];

  test("prior iterations block appears when priorAdversarialIterations is set", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    expect(result).toContain("## Prior Iterations — verdict required before new analysis");
  });

  test("prior iterations block contains the iteration number", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    expect(result).toContain("| 1 |");
  });

  test("prior iterations block contains strategy name and outcome", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    expect(result).toContain("source-fix");
    expect(result).toContain("partial");
  });

  test("prior iterations block contains finding count summary", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    // findingsBefore is empty (0), findingsAfter has 2 findings
    expect(result).toContain("0 →");
    expect(result).toContain("2 [");
  });

  test("prior iterations block appears before the story block (verdict-first)", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });
    const priorIdx = result.indexOf("## Prior Iterations");
    const storyIdx = result.indexOf("## Story Under Review");
    expect(priorIdx).toBeGreaterThanOrEqual(0);
    expect(priorIdx).toBeLessThan(storyIdx);
  });

  test("no prior iterations block when priorAdversarialIterations is undefined", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
    });
    expect(result).not.toContain("## Prior Iterations");
  });

  test("no prior iterations block when priorAdversarialIterations is empty array", () => {
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: [],
    });
    expect(result).not.toContain("## Prior Iterations");
  });

  test("unchanged outcome note appears when an iteration outcome is unchanged", () => {
    const unchangedIteration = {
      ...PRIOR_ITERATIONS[0],
      outcome: "unchanged" as const,
    };
    const result = builder.buildAdversarialReviewPrompt(STORY, CONFIG, {
      mode: "ref",
      storyGitRef: STORY_GIT_REF,
      priorAdversarialIterations: [unchangedIteration],
    });
    expect(result).toContain("FALSIFIED");
  });
});
